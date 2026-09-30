// End-to-end check of the engine against the model test (bench/): builds a throwaway "library" from
// data/thumbs (hard links in Eagle's images/<id>.info/<name>_thumbnail.png layout), starts the real
// engine with Eagle's runtime, lets it fingerprint and learn the training split, then asks it about
// the held-back videos as if they were unsorted. Compare with bench/ridge.py (77.5% / 85.2%).
//
//   node tools/validate-engine.js [--limit-folders N]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { fork } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const EAGLE = process.env.EAGLE_EXE || path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Eagle', 'Eagle.exe');
const limitArg = process.argv.indexOf('--limit-folders');
const LIMIT = limitArg > 0 ? Number(process.argv[limitArg + 1]) : 0;

function safeName(s) { return s.replace(/[\\/:*?"<>|]/g, '_'); }

(async () => {
	const ds = JSON.parse(fs.readFileSync(path.join(DATA, 'dataset.json'), 'utf8'));
	let items = ds.items;
	if (LIMIT) {
		const keep = new Set([...new Set(items.map((i) => i.folder))].slice(0, LIMIT));
		items = items.filter((i) => keep.has(i.folder));
	}
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-validate-'));
	const lib = path.join(tmp, 'Validate.library');
	const appData = path.join(tmp, 'appdata');
	fs.mkdirSync(path.join(appData, 'Folder Suggest', 'models'), { recursive: true });
	// the engine finds the model at its default location: link it there
	fs.linkSync(path.join(ROOT, 'models', 'pixai-v0.9-fingerprint-fp16.onnx'), path.join(appData, 'Folder Suggest', 'models', 'pixai-v0.9-fingerprint-fp16.onnx'));

	// folders from the dataset paths ("Animations/Franchise/Char")
	const folders = new Map();
	const idFor = (p) => {
		if (folders.has(p)) return folders.get(p).id;
		const parts = p.split('/');
		const parent = parts.length > 1 ? idFor(parts.slice(0, -1).join('/')) : null;
		const f = { id: `F${folders.size}`, name: parts[parts.length - 1], parent, tags: [] };
		folders.set(p, f);
		return f.id;
	};
	const engItems = [];
	const truth = new Map();
	for (const it of items) {
		const fid = idFor(it.path);
		const name = safeName(it.name);
		const dir = path.join(lib, 'images', `${it.id}.info`);
		fs.mkdirSync(dir, { recursive: true });
		fs.linkSync(path.join(DATA, it.thumb), path.join(dir, `${name}_thumbnail.png`));
		const test = it.split === 'test';
		if (test) truth.set(it.id, fid);
		engItems.push({ id: it.id, name, ext: 'mp4', folders: test ? [] : [fid], tags: [] });
	}
	console.log(`library: ${engItems.length} videos (${truth.size} held back) in ${folders.size} folders at ${lib}`);

	const child = fork(path.join(ROOT, 'plugin', 'js', 'engine', 'main.js'), [], {
		execPath: EAGLE, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LOCALAPPDATA: appData }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
	});
	let nextId = 1;
	const pending = new Map();
	const waiters = [];
	child.on('message', (m) => {
		if (m.event) {
			if (m.event === 'log') console.log(`  [${m.data.level}] ${m.data.message}`);
			for (const w of [...waiters]) if (w.event === m.event) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m.data); }
			return;
		}
		const p = pending.get(m.id); pending.delete(m.id);
		if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error));
	});
	const call = (cmd, args) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); child.send({ id, cmd, args }); });
	const waitFor = (event) => new Promise((resolve) => waiters.push({ event, resolve }));

	const settings = { minVideosPerFolder: 3, autoIndex: true, useGpu: true, freeGpuWhenIdle: false };
	const init = await call('init', { libraryPath: lib, pluginRoot: path.join(ROOT, 'plugin'), settings });
	console.log('init', init);
	const t0 = Date.now();
	await call('data', { items: engItems, folders: [...folders.values()] });
	// wait until everything is fingerprinted and the final training is done
	for (;;) {
		await new Promise((r) => setTimeout(r, 5000));
		const st = await call('status');
		process.stdout.write(`\r  fingerprinted ${st.stored}/${engItems.length}  ${st.index.rate.toFixed(1)}/s  pending ${st.index.pending}  failed ${st.index.failed}  training ${st.training}   `);
		if (!st.index.pending && !st.index.active && st.stored + st.index.failed >= engItems.length) break;
	}
	console.log(`\nfingerprinting took ${((Date.now() - t0) / 1000).toFixed(0)} s`);
	const trained = await call('train');
	console.log('learning:', JSON.stringify(trained.learning));

	// the held-back videos, as unsorted items
	const ids = [...truth.keys()];
	const t1 = Date.now();
	const res = await call('suggestMany', { ids, k: 3 });
	const manyMs = Date.now() - t1;
	let top1 = 0, top3 = 0, sure = 0, sureRight = 0, n = 0;
	for (const id of ids) {
		const r = res[id];
		if (!r || r.status !== 'ready') continue;
		n++;
		const picks = r.suggestions.map((s) => s.folderId);
		if (picks[0] === truth.get(id)) top1++;
		if (picks.includes(truth.get(id))) top3++;
		if (r.sure) { sure++; if (picks[0] === truth.get(id)) sureRight++; }
	}
	console.log(`held-back: ${n} videos | first pick right ${(100 * top1 / n).toFixed(1)}% | top 3 ${(100 * top3 / n).toFixed(1)}% | sure on ${(100 * sure / n).toFixed(1)}%, right ${(100 * sureRight / Math.max(1, sure)).toFixed(1)}% of those | ${manyMs} ms for all`);

	// the Inspector's route: HTTP /suggest for one video, timed
	const eng = JSON.parse(fs.readFileSync(path.join(appData, 'Folder Suggest', 'engine.json'), 'utf8'));
	const get = (p) => new Promise((resolve, reject) => {
		http.get({ host: '127.0.0.1', port: eng.port, path: p, agent: false, headers: { 'x-token': eng.token } }, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve(JSON.parse(b))); }).on('error', reject);
	});
	const one = ids[0];
	const t2 = Date.now();
	const h = await get(`/suggest?id=${one}`);
	console.log(`HTTP /suggest: ${Date.now() - t2} ms ->`, JSON.stringify(h.result.suggestions.map((s) => [s.name, s.prob.toFixed(2)])), 'sure', h.result.sure);
	const bad = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: eng.port, agent: false, path: `/suggest?id=${one}` }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', () => resolve('error')));
	console.log('request without token ->', bad);

	await call('shutdown').catch(() => {});
	child.disconnect();
	fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
