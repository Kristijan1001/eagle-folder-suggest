'use strict';
// Background engine. The plugin's service page starts it with Eagle's own runtime (Eagle.exe with
// ELECTRON_RUN_AS_NODE=1, Node 16) and feeds it the library (items + folders). It fingerprints
// videos, learns the folders, answers suggestion requests (from the service page over IPC and from
// the Inspector panel over a local HTTP port) and keeps the move history for Undo.

const fs = require('fs');
const path = require('path');
const { FingerprintStore } = require('./fpstore');
const { FingerprintModel, MatOps } = require('./model');
const { Indexer } = require('./indexer');
const trainer = require('./trainer');
const httpServer = require('./server');
const settingsMod = require('../core/settings');
const scope = require('../core/scope');
const { folderBase, titleMatches } = require('../core/names');
const { planMove } = require('../core/moves');
const ridge = require('../core/ridge');
const { withTitle, topK } = require('../core/suggest');
const paths = require('../core/paths');
const { MODEL, downloadModel } = require('./download');

const VIDEO_EXT = new Set(['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'm2ts', 'mts', '3gp', 'ogv', 'f4v', 'rmvb', 'rm', 'vob']);
const MAX_MOVES = 500;

const S = {
	settings: settingsMod.normalize({}),
	libraryPath: '', libKey: '', dir: '',
	pluginRoot: '',
	items: new Map(),           // id -> { id, name, ext, folders, tags, noThumbnail }
	folders: new Map(),         // id -> { id, name, parent, children, tags, path }
	learned: new Set(),
	counts: { videos: 0, sorted: 0, unsorted: 0 },
	store: null, model: null, ops: null, indexer: null,
	clf: null, clfRowMajor: null,
	training: null, trainAgain: false, trainTimer: null, newLabeled: 0,
	moves: [], movesTimer: null,
	reviewed: new Map(),        // id -> folders when the user chose to keep it there (review list)
	http: null,
	statusTimer: null,
	download: null,             // { got, total, error, ctl } while the model downloads
};

// ── plumbing ──
function send(msg) { if (process.send) { try { process.send(msg); } catch { /* page gone */ } } }
function emit(event, data) { send({ event, data }); }
function log(level, message) { emit('log', { t: Date.now(), level, message: String(message) }); }
const pause = () => new Promise((r) => setImmediate(r));

process.on('uncaughtException', (err) => log('error', `Engine error: ${err && err.stack || err}`));
process.on('unhandledRejection', (err) => log('error', `Engine error: ${err && err.stack || err}`));
process.on('disconnect', () => shutdown());

function shutdown() {
	try { if (S.indexer) S.indexer.stop(); } catch { /* ignore */ }
	try { if (S.store) S.store.flush(); } catch { /* ignore */ }
	try { saveMoves(true); } catch { /* ignore */ }
	try {
		const f = paths.engineFile();
		const cur = JSON.parse(fs.readFileSync(f, 'utf8'));
		if (cur.pid === process.pid) fs.unlinkSync(f);
	}
	catch { /* ignore */ }
	setTimeout(() => process.exit(0), 50);
}

const isVideo = (it) => !!it && VIDEO_EXT.has(String(it.ext || '').toLowerCase());
const isSorted = (it) => (it.folders || []).some((f) => S.learned.has(f));

function folderInfo(fid) {
	const f = S.folders.get(fid);
	if (!f) return { folderId: fid, name: '(missing folder)', path: '' };
	const parents = [];
	let p = f.parent ? S.folders.get(f.parent) : null;
	const seen = new Set();
	while (p && !seen.has(p.id)) { seen.add(p.id); parents.unshift(p.name); p = p.parent ? S.folders.get(p.parent) : null; }
	return { folderId: fid, name: f.name, path: parents.join(' / ') };
}

/**
 * The model file: the one chosen in Settings, else the first that exists of the data folder's
 * models\ and a models\ folder in or next to the plugin (a development checkout keeps it there).
 */
function modelPath() {
	if (S.settings.modelPath) return S.settings.modelPath;
	const candidates = [
		paths.defaultModelPath(),
		path.join(S.pluginRoot, 'models', paths.MODEL_FILE),
		path.join(S.pluginRoot, '..', 'models', paths.MODEL_FILE),
	];
	return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

// ── library state ──
function recount() {
	let videos = 0, sorted = 0;
	for (const it of S.items.values()) {
		if (!isVideo(it)) continue;
		videos++;
		if (isSorted(it)) sorted++;
	}
	S.counts = { videos, sorted, unsorted: videos - sorted };
}

function recomputeLearned() {
	const choices = settingsMod.learnChoices(S.settings, S.libKey);
	S.learned = scope.learnedSet(S.folders, choices);
	recount();
}

/** Fingerprint order: videos waiting to be sorted first (they need suggestions), then the sorted ones (training). */
function rebuildQueue() {
	const unsorted = [];
	const sorted = [];
	for (const it of S.items.values()) {
		if (!isVideo(it) || S.store.has(it.id)) continue;
		(isSorted(it) ? sorted : unsorted).push(it);
	}
	S.indexer.setQueue([...unsorted, ...sorted]);
	if (!S.settings.autoIndex) S.indexer.pause(); else if (!S.indexer.error) S.indexer.resume();
}

function setFolders(list) {
	S.folders = new Map();
	for (const f of list) S.folders.set(f.id, { id: f.id, name: f.name, parent: f.parent || null, children: [], tags: f.tags || [] });
	for (const f of S.folders.values()) if (f.parent && S.folders.has(f.parent)) S.folders.get(f.parent).children.push(f.id);
}

function plainItem(it) {
	return { id: it.id, name: it.name, ext: it.ext, folders: it.folders || [], tags: it.tags || [], noThumbnail: !!it.noThumbnail };
}

// ── training ──
function buildTraining() {
	const min = S.settings.minVideosPerFolder;
	const counts = new Map();
	for (const it of S.items.values()) {
		if (!isVideo(it) || !S.store.has(it.id)) continue;
		for (const f of it.folders) if (S.learned.has(f)) counts.set(f, (counts.get(f) || 0) + 1);
	}
	const classFolders = [...counts].filter(([, n]) => n >= min).map(([f]) => f)
		.sort((a, b) => (folderInfo(a).path + folderInfo(a).name).localeCompare(folderInfo(b).path + folderInfo(b).name));
	const clsOf = new Map(classFolders.map((f, i) => [f, i]));
	const classes = classFolders.map((f) => ({ folderId: f, name: S.folders.get(f).name, base: folderBase(S.folders.get(f).name) }));
	const examples = [];
	for (const it of S.items.values()) {
		if (!isVideo(it) || !S.store.has(it.id)) continue;
		for (const f of it.folders) if (clsOf.has(f)) examples.push({ id: it.id, name: it.name, cls: clsOf.get(f) });
	}
	return { classes, examples };
}

function trainSoon(ms) {
	clearTimeout(S.trainTimer);
	S.trainTimer = setTimeout(() => { trainNow().catch((err) => log('error', `Learning failed: ${err.message}`)); }, ms);
}

async function trainNow() {
	if (S.training) { S.trainAgain = true; return S.training; }
	const { classes, examples } = buildTraining();
	if (classes.length < 2 || examples.length < 20) {
		S.clf = null; S.clfRowMajor = null;
		pushStatus();
		return null;
	}
	S.training = (async () => {
		pushStatus();
		const clf = await trainer.train({ classes, examples, store: S.store, ops: S.ops, target: S.settings.sureTargetPercent / 100, pause });
		S.clf = clf;
		S.clfRowMajor = null;
		S.newLabeled = 0;
		const st = clf.stats;
		log('info', `Learned ${st.classes} folders from ${st.examples.toLocaleString()} videos in ${(st.ms / 1000).toFixed(1)} s`
			+ (st.calibrated ? ` - held-back check: first pick right ${pct(st.top1)}, top 3 ${pct(st.top3)}, "sure" on ${pct(st.sureShare)} (right ${pct(st.sureAccuracy)}).` : '.'));
		emit('trained', st);
		return clf;
	})();
	try { return await S.training; }
	finally {
		S.training = null;
		pushStatus();
		if (S.trainAgain) { S.trainAgain = false; trainSoon(500); }
	}
}
const pct = (v) => `${Math.round(v * 100)}%`;

function onIndexed(ids) {
	let labeled = 0;
	for (const id of ids) { const it = S.items.get(id); if (it && isSorted(it)) labeled++; }
	S.newLabeled += labeled;
	const pending = S.indexer.queue.length;
	if (!S.clf && !S.training) { if (S.newLabeled >= 200 || !pending) trainSoon(2000); }
	else if (S.newLabeled >= Math.max(1000, 0.15 * (S.clf ? S.clf.stats.examples : 0))) trainSoon(5000);
	else if (!pending && S.newLabeled > 0) trainSoon(3000);
	pushStatus();
}

// ── suggestions ──
function describe(pred, folders) {
	const clf = S.clf;
	return {
		status: 'ready',
		sure: pred.sure,
		loo: pred.loo,
		threshold: clf.threshold,
		suggestions: pred.ranked.map(({ cls, prob }) => {
			const fid = clf.classes[cls].folderId;
			return { ...folderInfo(fid), prob, current: folders.includes(fid), title: cls === pred.titleCls };
		}),
		current: folders.filter((f) => S.learned.has(f)).map(folderInfo),
	};
}

/** args from the Inspector come from the item itself (fresher than the service page's copy). */
async function suggest({ id, name, folders, ext, noThumbnail, k }) {
	if (!id) throw new Error('no item id');
	const known = S.items.get(id);
	const it = known ? { ...known } : { id, name: '', ext: ext || '', folders: [], tags: [], noThumbnail: noThumbnail === true || noThumbnail === 'true' };
	if (name) it.name = name;
	if (folders !== undefined) it.folders = Array.isArray(folders) ? folders : String(folders).split(',').filter(Boolean);
	if (!isVideo(it)) return { status: 'not-video' };
	const count = Math.min(5, Math.max(1, Number(k) || S.settings.suggestionCount));
	let x = S.store.get(id);
	let fresh = false;
	if (!x) {
		if (!S.model.available) return { status: 'no-model' };
		try { x = await S.indexer.fingerprintNow(it); fresh = true; }
		catch (err) { return { status: 'no-fingerprint', error: String(err.message || err) }; }
	}
	if (!S.clf) return { status: S.training ? 'training' : 'learning', ...S.counts, stored: S.store.size };
	const pred = trainer.predict(S.clf, id, it.name || '', x, count);
	return { ...describe(pred, it.folders), fresh };
}

/** Suggestions for many videos at once (the Sort view's queue). Missing fingerprints -> status 'pending'. */
async function suggestMany({ ids, k }) {
	const out = {};
	if (!S.clf) { for (const id of ids) out[id] = { status: S.training ? 'training' : 'learning' }; return out; }
	const clf = S.clf;
	const count = Math.min(5, Math.max(1, Number(k) || S.settings.suggestionCount));
	const D = ridge.D;
	const have = ids.filter((id) => S.store.has(id));
	for (const id of ids) if (!S.store.has(id)) out[id] = { status: 'pending' };
	if (!have.length) return out;
	if (!S.clfRowMajor) {
		const Wr = new Float32Array(D * clf.C);
		for (let c = 0; c < clf.C; c++) for (let i = 0; i < D; i++) Wr[i * clf.C + c] = clf.W[c * D + i];
		S.clfRowMajor = Wr;
	}
	const x = new Float32Array(1024);
	for (let s = 0; s < have.length; s += 2048) {
		const part = have.slice(s, s + 2048);
		const X = new Float32Array(part.length * D);
		part.forEach((id, r) => { S.store.get(id, x); X.set(x, r * D); X[r * D + 1024] = 1; });
		const sc = await S.ops.matmul(X, part.length, D, S.clfRowMajor, clf.C);
		part.forEach((id, r) => {
			const it = S.items.get(id) || { name: '', folders: [] };
			let s0 = Float64Array.from(sc.subarray(r * clf.C, (r + 1) * clf.C));
			const ex = clf.exampleOf.get(id);
			let loo = false;
			if (ex && ex.cls >= 0) { S.store.get(id, x); s0 = ridge.leaveOneOut(s0, clf.L, x, clf.weights[ex.cls], ex.cls); loo = true; }
			const { probs, title } = withTitle(ridge.softmax(s0, trainer.TEMP), titleMatches(it.name, clf.bases));
			const top = topK(probs, Math.min(count, clf.C));
			out[id] = describe({ ranked: top.map((c) => ({ cls: c, prob: probs[c] })), sure: probs[top[0]] >= clf.threshold, titleCls: title, loo }, it.folders || []);
		});
		await pause();
	}
	return out;
}

// ── review: sorted videos that look like they belong in another folder ──
// Each sorted video is judged the way it would be if it were not in the library (leave-one-out);
// it is listed when the plugin would put it in a different folder with a "sure" confidence.
// Videos the user kept where they are ("Keep") are remembered and not listed again unless they move.

function reviewedFile() { return path.join(S.dir, 'reviewed.json'); }
function loadReviewed() {
	try { S.reviewed = new Map(Object.entries(JSON.parse(fs.readFileSync(reviewedFile(), 'utf8')))); }
	catch { S.reviewed = new Map(); }
}
function saveReviewed() {
	fs.mkdirSync(S.dir, { recursive: true });
	fs.writeFileSync(`${reviewedFile()}.tmp`, JSON.stringify(Object.fromEntries(S.reviewed)));
	fs.renameSync(`${reviewedFile()}.tmp`, reviewedFile());
}
const folderKey = (it) => [...(it.folders || [])].sort().join(',');

/** (G + lam*I)^-1 as Float32 (d x d), from the stored Cholesky factor. */
function inverse(clf) {
	if (clf.inv) return clf.inv;
	const D = ridge.D;
	const inv = new Float32Array(D * D);
	const e = new Float64Array(D);
	for (let j = 0; j < D; j++) {
		e.fill(0); e[j] = 1;
		const col = ridge.cholSolve(clf.L, e, D);
		for (let i = 0; i < D; i++) inv[i * D + j] = col[i];
	}
	clf.inv = inv;
	return inv;
}

async function review() {
	if (!S.clf) return { status: S.training ? 'training' : 'learning', ids: [], checked: 0 };
	const clf = S.clf;
	if (clf.reviewIds) return { status: 'ready', ids: clf.reviewIds.filter(stillFlaggable), checked: clf.reviewChecked };
	const t0 = Date.now();
	const D = ridge.D;
	const C = clf.C;
	const cands = [];
	for (const [id, ex] of clf.exampleOf) {
		if (ex.cls < 0) continue;                                   // in several learned folders: skip
		const it = S.items.get(id);
		if (!it || !it.folders.includes(clf.classes[ex.cls].folderId)) continue;   // moved since learning
		if (S.reviewed.get(id) === folderKey(it)) continue;         // kept here before
		if (S.store.has(id)) cands.push({ id, cls: ex.cls, it });
	}
	if (!S.clfRowMajor) {
		const Wr = new Float32Array(D * C);
		for (let c = 0; c < C; c++) for (let i = 0; i < D; i++) Wr[i * C + c] = clf.W[c * D + i];
		S.clfRowMajor = Wr;
	}
	const inv = inverse(clf);
	const flagged = [];
	const x = new Float32Array(1024);
	for (let s = 0; s < cands.length; s += 2048) {
		const part = cands.slice(s, s + 2048);
		const X = new Float32Array(part.length * D);
		part.forEach((c, r) => { S.store.get(c.id, x); X.set(x, r * D); X[r * D + 1024] = 1; });
		const sc = await S.ops.matmul(X, part.length, D, S.clfRowMajor, C);
		const zm = await S.ops.matmul(X, part.length, D, inv, D);
		part.forEach((c, r) => {
			let h = 0;
			for (let i = 0; i < D; i++) h += zm[r * D + i] * X[r * D + i];
			h *= clf.weights[c.cls];
			if (!(h < 0.999)) return;
			const s1 = new Float64Array(C);
			for (let k = 0; k < C; k++) s1[k] = (sc[r * C + k] - (k === c.cls ? h : 0)) / (1 - h);
			const { probs } = withTitle(ridge.softmax(s1, trainer.TEMP), titleMatches(c.it.name, clf.bases));
			const top = topK(probs, 1)[0];
			if (top !== c.cls && probs[top] >= clf.threshold) flagged.push({ id: c.id, conf: probs[top] });
		});
		await pause();
	}
	flagged.sort((a, b) => b.conf - a.conf);
	clf.reviewIds = flagged.map((f) => f.id);
	clf.reviewChecked = cands.length;
	log('info', `Review: ${flagged.length.toLocaleString()} of ${cands.length.toLocaleString()} sorted videos look like they belong in another folder (${((Date.now() - t0) / 1000).toFixed(1)} s).`);
	return { status: 'ready', ids: clf.reviewIds, checked: cands.length };
}
function stillFlaggable(id) {
	const it = S.items.get(id);
	return !!it && S.reviewed.get(id) !== folderKey(it);
}

/** "Keep it where it is" in the review list. */
function keep({ id }) {
	const it = S.items.get(id);
	if (!it) return false;
	S.reviewed.set(id, folderKey(it));
	saveReviewed();
	return true;
}

// ── moves ──
function plan({ item, target }) {
	if (!S.folders.has(target)) throw new Error('That folder no longer exists.');
	return planMove(item, target, S.folders, {
		replaceFolders: S.settings.replaceFolders,
		swapTags: S.settings.swapAutoTags,
		keepFolder: (f) => !S.learned.has(f),
	});
}

function movesFile() { return path.join(S.dir, 'moves.json'); }
function loadMoves() {
	try { S.moves = JSON.parse(fs.readFileSync(movesFile(), 'utf8')); if (!Array.isArray(S.moves)) S.moves = []; }
	catch { S.moves = []; }
}
function saveMoves(now) {
	clearTimeout(S.movesTimer);
	const write = () => {
		if (!S.dir) return;
		fs.mkdirSync(S.dir, { recursive: true });
		fs.writeFileSync(`${movesFile()}.tmp`, JSON.stringify(S.moves.slice(-MAX_MOVES)));
		fs.renameSync(`${movesFile()}.tmp`, movesFile());
	};
	if (now) write(); else S.movesTimer = setTimeout(() => { try { write(); } catch (err) { log('warn', `Saving the move history failed: ${err.message}`); } }, 1000);
}

function applyItemState(id, state) {
	const it = S.items.get(id);
	if (!it) return;
	const wasSorted = isSorted(it);
	it.folders = [...(state.folders || it.folders)];
	it.tags = [...(state.tags || it.tags)];
	if (isVideo(it) && wasSorted !== isSorted(it)) recount();
}

/** A move was applied in Eagle (by the service page or the Inspector). */
function moved({ id, name, before, after, target, source, batch }) {
	applyItemState(id, after);
	S.moves.push({ t: Date.now(), id, name: name || (S.items.get(id) || {}).name || id, before, after, target, source: source || 'panel', batch: batch || null, undone: false });
	if (S.moves.length > MAX_MOVES + 100) S.moves.splice(0, S.moves.length - MAX_MOVES);
	saveMoves();
	emit('moved', { id, target, source });
	trainSoon(20000);
	return { ok: true };
}

function lastMove() {
	for (let i = S.moves.length - 1; i >= 0; i--) {
		const m = S.moves[i];
		if (m.undone) continue;
		const group = m.batch ? S.moves.filter((x) => x.batch === m.batch && !x.undone) : [m];
		return { ...m, targetInfo: folderInfo(m.target), count: group.length, entries: group };
	}
	return null;
}

function undone({ ids, batch }) {
	const set = new Set(ids || []);
	for (const m of S.moves) {
		if (m.undone) continue;
		if ((batch && m.batch === batch) || set.has(m.id)) {
			if (!batch && S.moves.some((x) => x.id === m.id && !x.undone && x.t > m.t)) continue;   // only the latest move of an item
			m.undone = true;
			applyItemState(m.id, m.before);
		}
	}
	saveMoves();
	emit('moved', { undo: true });
	trainSoon(20000);
	return { ok: true };
}

// ── status ──
function status() {
	const clf = S.clf;
	return {
		library: S.libraryPath,
		model: { ...S.model.status(), size: MODEL.size, download: S.download ? { got: S.download.got, total: S.download.total, error: S.download.error || '' } : null },
		index: S.indexer.status(),
		stored: S.store.size,
		...S.counts,
		learnedFolders: S.learned.size,
		folders: S.folders.size,
		training: !!S.training,
		learning: clf ? clf.stats : null,
		threshold: clf ? clf.threshold : null,
		port: S.http ? S.http.port : 0,
	};
}
function pushStatus() {
	if (S.statusTimer) return;
	S.statusTimer = setTimeout(() => { S.statusTimer = null; emit('status', status()); }, 500);
}
setInterval(() => { if (S.indexer && S.indexer.status().active) pushStatus(); }, 1000);

// ── library switching ──
function openLibrary(libraryPath) {
	if (S.store) { try { S.store.flush(); } catch { /* ignore */ } saveMoves(true); }
	S.libraryPath = paths.normalizeLibraryPath(libraryPath);
	S.libKey = paths.libraryKey(S.libraryPath);
	S.dir = paths.libraryDir(S.libraryPath);
	S.store = new FingerprintStore(S.dir);
	const r = S.store.load();
	if (r.reset) log('warn', 'The fingerprint file was unreadable and has been set aside; fingerprinting starts over.');
	S.items = new Map();
	S.folders = new Map();
	S.learned = new Set();
	S.clf = null; S.clfRowMajor = null;
	loadMoves();
	loadReviewed();
	if (S.indexer) S.indexer.stop();
	S.indexer = new Indexer({ store: S.store, model: S.model, log, onBatch: onIndexed });
	S.indexer.libraryPath = S.libraryPath;
	S.indexer.run();
	return r.loaded;
}

function writeEngineFile() {
	const f = paths.engineFile();
	fs.mkdirSync(path.dirname(f), { recursive: true });
	fs.writeFileSync(f, JSON.stringify({ port: S.http.port, token: S.http.token, pid: process.pid, library: S.libraryPath, started: Date.now() }));
}

// ── commands (service page -> engine) ──
const commands = {
	async init({ libraryPath, pluginRoot, settings }) {
		S.settings = settingsMod.normalize(settings);
		S.pluginRoot = pluginRoot;
		if (!S.ops) S.ops = new MatOps(path.join(pluginRoot, 'models'));
		if (!S.model) S.model = new FingerprintModel({ log });
		S.model.configure({ ...S.settings, modelPath: modelPath() });
		const stored = openLibrary(libraryPath);
		if (!S.http) {
			S.http = await httpServer.start({
				'GET /suggest': (a) => suggest(a),
				'POST /plan': (a) => plan(a),
				'POST /moved': (a) => moved({ ...a, source: a.source || 'inspector' }),
				'GET /last-move': () => lastMove(),
				'POST /undone': (a) => undone(a),
				'GET /status': () => status(),
				'POST /log': (a) => { log(a.level || 'info', `[panel] ${a.message}`); return true; },
			}, log);
		}
		writeEngineFile();
		return { stored, node: process.versions.node, port: S.http.port, modelPath: modelPath(), modelAvailable: S.model.available };
	},

	data({ items, folders }) {
		setFolders(folders);
		S.items = new Map(items.map((it) => [it.id, plainItem(it)]));
		recomputeLearned();
		rebuildQueue();
		trainSoon(300);
		return status();
	},

	itemsChanged({ upsert = [], remove = [] }) {
		let labelsChanged = false;
		const fresh = [];
		for (const raw of upsert) {
			const it = plainItem(raw);
			const prev = S.items.get(it.id);
			if (!prev) { if (isVideo(it)) fresh.push(it); labelsChanged = true; }
			else if (prev.folders.join() !== it.folders.join() || prev.name !== it.name) labelsChanged = true;
			S.items.set(it.id, it);
		}
		for (const id of remove) if (S.items.delete(id)) labelsChanged = true;
		recount();
		if (fresh.length) {
			S.indexer.add(fresh.filter((it) => !isSorted(it)), true);
			S.indexer.add(fresh.filter((it) => isSorted(it)));
		}
		if (labelsChanged && S.clf) trainSoon(20000);
		pushStatus();
		return { added: fresh.length };
	},

	foldersChanged({ folders }) {
		setFolders(folders);
		recomputeLearned();
		trainSoon(1000);
		return status();
	},

	settings({ settings }) {
		const prev = S.settings;
		S.settings = settingsMod.normalize(settings);
		S.model.configure({ ...S.settings, modelPath: modelPath() });
		const learnChanged = JSON.stringify(settingsMod.learnChoices(prev, S.libKey)) !== JSON.stringify(settingsMod.learnChoices(S.settings, S.libKey));
		if (learnChanged) { recomputeLearned(); rebuildQueue(); }
		if (learnChanged || prev.minVideosPerFolder !== S.settings.minVideosPerFolder || prev.sureTargetPercent !== S.settings.sureTargetPercent) trainSoon(800);
		if (prev.autoIndex !== S.settings.autoIndex) { if (S.settings.autoIndex) S.indexer.resume(); else S.indexer.pause(); }
		if (prev.modelPath !== S.settings.modelPath || prev.useGpu !== S.settings.useGpu) { S.indexer.error = ''; S.indexer.resume(); }
		pushStatus();
		return status();
	},

	status: () => status(),
	pause() { S.indexer.pause(); pushStatus(); return true; },
	resume() { S.indexer.resume(); pushStatus(); return true; },
	async train() { await trainNow(); return status(); },
	suggest: (a) => suggest(a),
	suggestMany: (a) => suggestMany(a),
	plan: (a) => plan(a),
	moved: (a) => moved(a),
	lastMove: () => lastMove(),
	undone: (a) => undone(a),
	history: ({ limit = 50 } = {}) => S.moves.slice(-limit).reverse().map((m) => ({ ...m, targetInfo: folderInfo(m.target) })),
	/** Video ids for the Sort view: 'unsorted' (outside the learned folders), 'folder' (in folderId), or given ids. */
	queue({ source, folderId, ids }) {
		if (source === 'selection') return (ids || []).filter((id) => isVideo(S.items.get(id)));
		const out = [];
		for (const it of S.items.values()) {
			if (!isVideo(it)) continue;
			if (source === 'unsorted' && isSorted(it)) continue;
			if (source === 'folder' && !it.folders.includes(folderId)) continue;
			out.push(it.id);
		}
		return out;
	},
	learned: () => [...S.learned],
	review: () => review(),
	keep: (a) => keep(a),
	reindex({ all }) {
		if (all) { S.store.clear(); S.clf = null; S.clfRowMajor = null; }
		S.indexer.failed.clear();
		rebuildQueue();
		return status();
	},
	failures: () => [...S.indexer.failed].slice(0, 200).map(([id, reason]) => ({ id, name: (S.items.get(id) || {}).name || id, reason })),
	async unloadModel() { S.model.release(); return true; },
	/** Download the model from the project's release (the page asks the user first). */
	downloadModel() {
		if (S.download && !S.download.error) return true;
		const ctl = { aborted: false, abort: null };
		S.download = { got: 0, total: MODEL.size, ctl };
		const dir = path.dirname(paths.defaultModelPath());
		downloadModel(dir, (got, total) => { S.download.got = got; S.download.total = total; emit('modelDownload', { got, total }); pushStatus(); }, ctl)
			.then((file) => {
				S.download = null;
				log('info', `Model downloaded and verified: ${file}`);
				S.model.configure({ ...S.settings, modelPath: modelPath() });
				S.indexer.error = '';
				if (S.settings.autoIndex) S.indexer.resume();
				emit('modelDownload', { done: true });
				pushStatus();
			})
			.catch((err) => {
				S.download = ctl.aborted ? null : { got: 0, total: MODEL.size, error: String(err.message || err) };
				if (!ctl.aborted) log('error', `Model download failed: ${err.message}`);
				emit('modelDownload', { error: ctl.aborted ? 'cancelled' : String(err.message || err) });
				pushStatus();
			});
		return true;
	},
	cancelDownload() { if (S.download && S.download.ctl && S.download.ctl.abort) S.download.ctl.abort(); return true; },
	shutdown() { shutdown(); return true; },
};

process.on('message', async (m) => {
	if (!m || !m.cmd) return;
	const fn = commands[m.cmd];
	if (!fn) { send({ id: m.id, ok: false, error: `Unknown command ${m.cmd}` }); return; }
	try { send({ id: m.id, ok: true, result: await fn(m.args || {}) }); }
	catch (err) { send({ id: m.id, ok: false, error: String(err && err.message || err), stack: err && err.stack }); }
});

module.exports = { commands, S };
