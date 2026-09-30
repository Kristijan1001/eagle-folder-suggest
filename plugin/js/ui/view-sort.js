'use strict';
// Sort: one video at a time with its suggested folders; a key press moves it and shows the next.
//   1-5 move to that suggestion, Enter the first · S / Right skip · Left back · Z undo
//   Space play / pause · F search any folder

const path = require('path');
const { h, icon, clear, number, fileUrl } = require('./dom');
const kit = require('./kit');

const pct = (v) => (v > 0 && v < 0.005 ? '<1%' : `${Math.round((v || 0) * 100)}%`);

function create(app) {
	const el = h('div.sort');
	const S = {
		source: app.settings.sortSource,
		folderId: app.settings.sortFolderId,
		queue: [],
		pos: 0,
		preds: new Map(),
		done: new Map(),          // id -> folderId it was moved to
		loading: false,
		searchOpen: false,
		searchSel: 0,
		playing: false,
	};
	let stageEl, sideEl, stripEl, barEl, searchInput, searchResults;

	const itemOf = (id) => app.data.items.get(id);
	const folderName = (fid) => { const f = app.data.folders.get(fid); return f ? f.name : '(missing folder)'; };
	const folderPath = (fid) => { const f = app.data.folders.get(fid); return f ? f.path : ''; };
	const thumbPath = (it) => path.join(app.data.libraryPath, 'images', `${it.id}.info`, it.noThumbnail ? `${it.name}.${it.ext}` : `${it.name}_thumbnail.png`);
	const filePath = (it) => path.join(app.data.libraryPath, 'images', `${it.id}.info`, `${it.name}.${it.ext}`);

	async function loadQueue() {
		S.loading = true;
		render();
		let ids = [];
		try {
			if (S.source === 'selection') {
				const sel = await eagle.item.get({ isSelected: true, fields: ['id'] });
				ids = await app.engine.call('queue', { source: 'selection', ids: sel.map((i) => i.id) });
			}
			else ids = await app.engine.call('queue', { source: S.source, folderId: S.folderId });
		}
		catch (err) { app.log('warn', `Could not build the sort queue: ${err.message}`); }
		S.queue = ids;
		S.pos = 0;
		S.preds.clear();
		S.done.clear();
		S.loading = false;
		await fetchPreds(0);
		render();
	}

	/** Suggestions for the videos around position p (and all of them when `all`). */
	async function fetchPreds(p, all = false) {
		const ids = all ? S.queue : S.queue.slice(Math.max(0, p - 5), p + 40);
		const need = ids.filter((id) => !S.preds.has(id) || S.preds.get(id).status !== 'ready');
		if (!need.length) return;
		try {
			const res = await app.engine.call('suggestMany', { ids: need, k: app.settings.suggestionCount });
			for (const [id, r] of Object.entries(res)) S.preds.set(id, r);
		}
		catch (err) { app.log('warn', `Suggestions failed: ${err.message}`); }
		// the current video may not be fingerprinted yet: ask for it directly (fingerprints on the spot)
		const cur = S.queue[S.pos];
		if (cur && (!S.preds.get(cur) || S.preds.get(cur).status === 'pending')) {
			try { S.preds.set(cur, await app.engine.call('suggest', { id: cur, k: app.settings.suggestionCount })); } catch { /* shown as pending */ }
		}
	}

	function currentId() { return S.queue[S.pos]; }

	function nextOpen(from, dir = 1) {
		for (let p = from; p >= 0 && p < S.queue.length; p += dir) {
			if (!S.done.has(S.queue[p])) return p;
		}
		return -1;
	}

	async function go(p) {
		if (p < 0 || p >= S.queue.length) return;
		S.pos = p;
		S.playing = false;
		render();
		await fetchPreds(p);
		if (S.pos === p) render();
	}

	async function moveCurrent(target) {
		const id = currentId();
		if (!id || !target) return;
		const it = itemOf(id);
		try {
			await app.move(id, target, { source: 'sort' });
			S.done.set(id, target);
			kit.toast(`Moved "${it ? it.name : id}" to ${folderName(target)}.`, { kind: 'good', timeout: 3000, action: { label: 'Undo', onClick: undo } });
			const n = nextOpen(S.pos + 1);
			if (n >= 0) go(n); else render();
		}
		catch (err) { kit.alertDialog('Move failed', err.message, 'error'); }
	}

	async function undo() {
		const last = await app.undoLast();
		if (!last) return;
		for (const e of last.entries) S.done.delete(e.id);
		const i = S.queue.indexOf(last.entries[0].id);
		if (i >= 0) go(i); else render();
	}

	async function moveAllSure() {
		await fetchPreds(0, true);
		const picks = S.queue.filter((id) => {
			const r = S.preds.get(id);
			return !S.done.has(id) && r && r.status === 'ready' && r.sure && r.suggestions[0] && !r.suggestions[0].current;
		});
		if (!picks.length) { kit.toast('No sure suggestions in this list.'); return; }
		const l = app.status && app.status.learning;
		const ok = await kit.confirmDialog({
			title: `Move ${number(picks.length)} videos?`,
			icon: 'sparkle',
			message: `Every video in this list whose first suggestion is marked sure goes to that folder.${l && l.calibrated ? ` Sure suggestions were right ${pct(l.sureAccuracy)} of the time on your held-back videos.` : ''}\n\nThe whole batch can be undone in one step.`,
			okLabel: `Move ${number(picks.length)}`,
		});
		if (!ok) return;
		const batch = `b${Date.now()}`;
		const b = kit.busy('Moving videos');
		let n = 0, failed = 0;
		for (const id of picks) {
			const target = S.preds.get(id).suggestions[0].folderId;
			try { await app.move(id, target, { source: 'sort-batch', batch }); S.done.set(id, target); n++; }
			catch (err) { failed++; app.log('warn', `Moving ${id} failed: ${err.message}`); }
			b.update(`${number(n)} of ${number(picks.length)}`, (n + failed) / picks.length);
		}
		b.close();
		kit.toast(`Moved ${number(n)} videos${failed ? `, ${failed} failed (see Log)` : ''}.`, { kind: failed ? 'bad' : 'good', timeout: 6000, action: { label: 'Undo all', onClick: undo } });
		const nx = nextOpen(S.pos);
		if (nx >= 0) go(nx); else render();
	}

	// ── folder search ──
	function searchMatches(q) {
		const words = q.toLowerCase().split(/\s+/).filter(Boolean);
		const out = [];
		for (const f of app.data.folders.values()) {
			const hay = `${f.path}`.toLowerCase();
			if (words.every((w) => hay.includes(w))) out.push(f);
			if (out.length > 200) break;
		}
		out.sort((a, b) => {
			const an = a.name.toLowerCase().startsWith(words[0] || '') ? 0 : 1;
			const bn = b.name.toLowerCase().startsWith(words[0] || '') ? 0 : 1;
			return an - bn || a.path.localeCompare(b.path);
		});
		return out.slice(0, 40);
	}
	function renderSearch() {
		if (!searchResults) return;
		clear(searchResults);
		const q = searchInput.value.trim();
		if (!q) { searchResults.style.display = 'none'; return; }
		const list = searchMatches(q);
		searchResults.style.display = '';
		S.searchSel = Math.min(S.searchSel, Math.max(0, list.length - 1));
		if (!list.length) searchResults.append(h('div.res.faint', 'No folder matches.'));
		list.forEach((f, i) => {
			searchResults.append(h(`div.res${i === S.searchSel ? '.on' : ''}`, { onmousedown: (e) => { e.preventDefault(); moveCurrent(f.id); searchInput.value = ''; renderSearch(); } },
				icon('folder', 14), h('span', f.name), h('span.p', f.path.includes(' / ') ? f.path.slice(0, f.path.lastIndexOf(' / ')) : '')));
		});
		searchResults.list = list;
	}

	// ── render ──
	function renderBar() {
		const seg = h('div.seg',
			...[['unsorted', 'Waiting to be sorted'], ['folder', 'A folder'], ['selection', 'Selected in Eagle']].map(([k, label]) =>
				h(`button${S.source === k ? '.on' : ''}`, { onclick: () => { S.source = k; app.setSettings({ sortSource: k }); loadQueue(); } }, label)));
		let folderSel = null;
		if (S.source === 'folder') {
			folderSel = h('select.select', { onchange: (e) => { S.folderId = e.target.value; app.setSettings({ sortFolderId: S.folderId }); loadQueue(); } },
				h('option', { value: '' }, 'Choose a folder…'),
				...[...app.data.folders.values()].sort((a, b) => a.path.localeCompare(b.path)).map((f) => h('option', { value: f.id, selected: f.id === S.folderId }, f.path)));
			folderSel.style.maxWidth = '340px';
		}
		const openCount = S.queue.filter((id) => !S.done.has(id)).length;
		return h('div.sort-bar', seg, folderSel,
			h('span.pos', S.queue.length ? `${number(Math.min(S.pos + 1, S.queue.length))} / ${number(S.queue.length)}${S.done.size ? ` · ${number(S.done.size)} moved` : ''}` : ''),
			h('span.spacer'),
			h('button.btn', { title: 'Undo the last move (Z)', onclick: undo }, icon('undo', 14), 'Undo'),
			h('button.btn.primary', { disabled: !openCount, onclick: moveAllSure }, icon('sparkle', 14), 'Move all sure…'));
	}

	function renderStage(it) {
		const stage = h('div.stage');
		if (!it) return stage;
		if (S.playing) {
			const v = h('video', { src: fileUrl(filePath(it)), autoplay: true, controls: true, loop: true });
			v.addEventListener('error', () => { S.playing = false; kit.toast('This video cannot be played here.', { kind: 'bad' }); render(); });
			stage.append(v);
		}
		else {
			const img = h('img', { src: fileUrl(thumbPath(it)), alt: '', draggable: false });
			stage.append(img, h('div.play-hint', icon('play', 12), 'Space to play'));
			stage.addEventListener('click', () => { S.playing = true; render(); });
		}
		return stage;
	}

	function sugRow(s, i, sure) {
		const row = h(`div.sug${i === 0 ? '.first' : ''}${i === 0 && sure ? '.sure' : ''}${s.current ? '.current' : ''}`, { onclick: () => moveCurrent(s.folderId), title: s.current ? 'Already in this folder' : `Move to ${s.name}` },
			h('kbd.key', String(i + 1)),
			h('div', { style: { minWidth: 0 } },
				h('div.fn', s.name,
					h('span.flags', s.title ? h('span.badge', { title: 'The title names this folder' }, 'title') : null,
						s.current ? h('span.badge', 'current') : null)),
				h('div.fp', s.path || ' ')),
			h('span.pc', pct(s.prob)),
			h('div.meter', { style: { width: `${Math.round(s.prob * 100)}%` } }));
		return row;
	}

	function renderSide(it) {
		const side = h('div.side');
		if (!it) return side;
		const r = S.preds.get(it.id);
		const cur = (it.folders || []).map(folderName);
		side.append(h('div.title', it.name),
			h('div.where', icon('folder', 13), cur.length ? cur.join(', ') : 'In no folder'));
		const doneTo = S.done.get(it.id);
		if (doneTo) side.append(h('div.callout.info', icon('check', 16), h('div', 'Moved to ', h('b', folderName(doneTo)), '. ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); undo(); } }, 'Undo'))));
		const sugs = h('div.sugs');
		if (!r || r.status === 'pending') sugs.append(h('div.muted', 'Fingerprinting…'));
		else if (r.status === 'ready') {
			r.suggestions.forEach((s, i) => sugs.append(sugRow(s, i, r.sure)));
			if (r.sure) {
				const l = app.status && app.status.learning;
				sugs.append(h('div.small', { style: { color: 'var(--good)' } }, l && l.calibrated
					? `Sure: suggestions this confident were right ${pct(l.sureAccuracy)} of the time on your held-back videos.`
					: 'Sure: the title or the model is very confident.'));
			}
		}
		else if (r.status === 'learning' || r.status === 'training') sugs.append(h('div.muted', 'Still learning your folders…'));
		else if (r.status === 'no-model') sugs.append(h('div.callout.warn', icon('warning', 16), h('div', 'The fingerprint model is missing: see Overview.')));
		else sugs.append(h('div.muted', r.error || 'No suggestion for this video.'));
		side.append(sugs);
		searchInput = h('input.input', { placeholder: 'Move to another folder…  (F)', style: { width: '100%' } });
		searchResults = h('div.results', { style: { display: 'none' } });
		searchInput.addEventListener('input', () => { S.searchSel = 0; renderSearch(); });
		searchInput.addEventListener('keydown', (e) => {
			const list = searchResults.list || [];
			if (e.key === 'ArrowDown') { S.searchSel = Math.min(S.searchSel + 1, list.length - 1); renderSearch(); e.preventDefault(); }
			else if (e.key === 'ArrowUp') { S.searchSel = Math.max(S.searchSel - 1, 0); renderSearch(); e.preventDefault(); }
			else if (e.key === 'Enter' && list[S.searchSel]) { moveCurrent(list[S.searchSel].id); searchInput.value = ''; renderSearch(); searchInput.blur(); e.preventDefault(); }
			else if (e.key === 'Escape') { searchInput.value = ''; renderSearch(); searchInput.blur(); e.preventDefault(); }
			e.stopPropagation();
		});
		side.append(h('div.search-box', searchInput, searchResults));
		side.append(h('div.keys',
			h('span', h('kbd', '1'), '–', h('kbd', String(Math.max(1, r && r.suggestions ? r.suggestions.length : 3))), 'move'),
			h('span', h('kbd', 'Enter'), 'first'),
			h('span', h('kbd', 'S'), 'skip'),
			h('span', h('kbd', '←'), 'back'),
			h('span', h('kbd', 'Z'), 'undo'),
			h('span', h('kbd', 'Space'), 'play'),
			h('span', h('kbd', 'F'), 'search')));
		return side;
	}

	function renderStrip() {
		const strip = h('div.strip');
		const from = Math.max(0, S.pos - 6);
		for (let p = from; p < Math.min(S.queue.length, from + 40); p++) {
			const id = S.queue[p];
			const it = itemOf(id);
			if (!it) continue;
			const r = S.preds.get(id);
			strip.append(h(`div.cell${p === S.pos ? '.on' : ''}${S.done.has(id) ? '.done' : ''}`, { title: it.name, onclick: () => go(p) },
				h('img', { src: fileUrl(thumbPath(it)), alt: '', loading: 'lazy', draggable: false }),
				r && r.status === 'ready' ? h(`span.dot${r.sure ? '.sure' : ''}`) : null));
		}
		return strip;
	}

	function render() {
		clear(el);
		if (!app.ready) { el.append(h('div.empty', h('h3', 'Starting…'))); return; }
		barEl = renderBar();
		el.append(barEl);
		if (S.loading) { el.append(h('div.empty', h('h3', 'Loading…'))); return; }
		if (S.source === 'folder' && !S.folderId) { el.append(h('div.empty', icon('folder', 34), h('h3', 'Choose a folder to go through'))); return; }
		if (!S.queue.length) {
			el.append(h('div.empty', icon('checkCircle', 34), h('h3', S.source === 'unsorted' ? 'Nothing waiting to be sorted' : 'No videos here'),
				h('div', S.source === 'selection' ? 'Select videos in Eagle, then click "Selected in Eagle" again.' : '')));
			return;
		}
		const it = itemOf(currentId());
		if (S.done.size === S.queue.length) {
			el.append(h('div.empty', icon('checkCircle', 34), h('h3', 'All done'), h('div', `${number(S.done.size)} videos moved.`)));
			return;
		}
		stageEl = renderStage(it);
		sideEl = renderSide(it);
		stripEl = renderStrip();
		el.append(h('div.sort-main', stageEl, sideEl), stripEl);
	}

	function onKey(e) {
		if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return false;
		if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) { undo(); return true; }
		if (e.ctrlKey || e.altKey || e.metaKey) return false;
		const r = S.preds.get(currentId());
		if (e.key >= '1' && e.key <= '5') {
			const s = r && r.status === 'ready' ? r.suggestions[Number(e.key) - 1] : null;
			if (s) moveCurrent(s.folderId);
			return true;
		}
		switch (e.key) {
			case 'Enter': if (r && r.status === 'ready' && r.suggestions[0]) moveCurrent(r.suggestions[0].folderId); return true;
			case 's': case 'S': case 'ArrowRight': case 'ArrowDown': go(Math.min(S.pos + 1, S.queue.length - 1)); return true;
			case 'ArrowLeft': case 'ArrowUp': go(Math.max(S.pos - 1, 0)); return true;
			case 'z': case 'Z': undo(); return true;
			case ' ': S.playing = !S.playing; render(); return true;
			case 'f': case 'F': case '/': if (searchInput) searchInput.focus(); return true;
			default: return false;
		}
	}

	app.on('trained', () => { S.preds.clear(); if (app.current === 'sort') fetchPreds(S.pos).then(render); });
	// undos and moves made elsewhere (Overview, the Inspector panel) keep this list honest
	app.on('undone', (last) => {
		for (const e of last.entries || []) S.done.delete(e.id);
		if (app.current === 'sort') render();
	});
	app.on('moved', (m) => {
		if (!m || m.undo || m.source === 'sort' || !m.id || !S.queue.includes(m.id)) return;
		S.done.set(m.id, m.target);
		if (app.current === 'sort') render();
	});
	app.on('ready', () => { if (app.current === 'sort') loadQueue(); });

	let shown = false;
	return {
		el,
		show(opts) {
			if (opts && opts.source) { S.source = opts.source; app.setSettings({ sortSource: opts.source }); shown = false; }
			if (!shown && app.ready) { shown = true; loadQueue(); } else render();
		},
		hide() { S.playing = false; },
		onKey,
	};
}

module.exports = { create };
