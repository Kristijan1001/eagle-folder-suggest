'use strict';
// Settings: which folders to learn from, learning, moving, fingerprinting.

const { h, icon, clear, number } = require('./dom');
const settingsMod = require('../core/settings');
const scope = require('../core/scope');
const paths = require('../core/paths');

function create(app) {
	const kit = app.kit;
	const el = h('div.settings');
	const s = () => app.settings;
	const set = (patch) => app.setSettings(patch);
	const expanded = new Set();
	let section = 'folders';
	let mainEl = null;

	// ── rows ──
	function row(label, desc, control) {
		return h('div.set-row', h('div.l', h('div.n', label), desc ? h('div.d', desc) : null), h('div.r', control));
	}
	function sw(key) {
		const inp = h('input', { type: 'checkbox', checked: !!s()[key], onchange: (e) => set({ [key]: e.target.checked }) });
		return h('label.switch', inp, h('span.track'));
	}
	function num(key, unit) {
		const [min, max] = settingsMod.RANGES[key] || [0, 1e9];
		const inp = h('input.input.num', { type: 'number', min, max, value: s()[key] });
		inp.addEventListener('change', () => { set({ [key]: Number(inp.value) }); inp.value = s()[key]; });
		return h('div.row', inp, unit ? h('span.faint', unit) : null);
	}
	function range(key, unit) {
		const [min, max] = settingsMod.RANGES[key];
		const val = h('span.val', `${s()[key]}${unit}`);
		const inp = h('input', { type: 'range', min, max, step: 1, value: s()[key], style: { width: '200px' } });
		inp.addEventListener('input', () => { val.textContent = `${inp.value}${unit}`; });
		inp.addEventListener('change', () => set({ [key]: Number(inp.value) }));
		return h('div.range', inp, val);
	}

	// ── folder tree ──
	function directVideoCounts() {
		const out = new Map();
		const VIDEO = /^(mp4|webm|mkv|mov|avi|m4v|wmv|flv|mpg|mpeg|ts|m2ts|mts|3gp|ogv|f4v|rmvb|rm|vob)$/i;
		for (const it of app.data.items.values()) {
			if (!VIDEO.test(it.ext || '')) continue;
			for (const f of it.folders) out.set(f, (out.get(f) || 0) + 1);
		}
		return out;
	}

	function renderTree() {
		const folders = app.data.folders;
		const choices = settingsMod.learnChoices(s(), app.libKey);
		const learned = scope.learnedSet(folders, choices);
		const counts = directVideoCounts();
		const tree = h('div.tree', { style: { maxHeight: 'none' } });
		const rowFor = (id, depth) => {
			const f = folders.get(id);
			const state = scope.treeState(id, folders, learned);
			const cb = h('input', { type: 'checkbox', checked: state === 'on' });
			cb.indeterminate = state === 'mixed';
			cb.addEventListener('click', (e) => {
				e.stopPropagation();
				const next = scope.toggle(id, folders, choices, state !== 'on');
				const libraries = { ...s().libraries, [app.libKey]: { learn: next } };
				set({ libraries });
				renderMain();
			});
			const hasKids = f.children.length > 0;
			const tw = h(`span.tw${hasKids ? '' : '.leaf'}`, icon(expanded.has(id) ? 'chevronDown' : 'chevronRight', 14));
			const r = h('div.tree-row', { style: { paddingLeft: `${4 + depth * 18}px` }, onclick: () => { if (!hasKids) return; if (expanded.has(id)) expanded.delete(id); else expanded.add(id); renderMain(); } },
				tw, cb, icon('folder', 15), h('span.name', f.name), counts.get(id) ? h('span.cnt', number(counts.get(id))) : null);
			if (!learned.has(id)) r.classList.add('excluded');
			tree.append(r);
			if (hasKids && expanded.has(id)) for (const c of [...f.children].sort((a, b) => folders.get(a).name.localeCompare(folders.get(b).name))) rowFor(c, depth + 1);
		};
		const roots = [...app.data.roots].sort((a, b) => folders.get(a).name.localeCompare(folders.get(b).name));
		for (const id of roots) rowFor(id, 0);
		if (!roots.length) tree.append(h('div.tree-empty', 'No folders in this library.'));
		return tree;
	}

	// ── sections ──
	const SECTIONS = [
		{ id: 'folders', title: 'Folders to learn', icon: 'folder', render: () => [
			h('div.desc', 'Folder Suggest learns what goes where from the videos already in these folders, and only ever suggests them. Untick staging or catch-all folders (like the one new videos arrive in) so they are not suggested. A folder needs at least a few videos before it is suggested.'),
			renderTree(),
		] },
		{ id: 'learning', title: 'Learning', icon: 'sparkle', render: () => [
			row('Videos a folder needs', 'Folders with fewer fingerprinted videos are not suggested yet.', num('minVideosPerFolder')),
			row('"Sure" means right at least', 'The confidence for a green "sure" suggestion is picked from your own held-back videos so that sure suggestions are right at least this often.', range('sureTargetPercent', '%')),
			row('Suggestions shown', 'How many folders the panel and the Sort page offer.', num('suggestionCount')),
		] },
		{ id: 'moving', title: 'Moving', icon: 'sortIn', render: () => [
			row('Take the video out of its other folders', 'On: a move works like Eagle\'s "Move to folder". Off: folders you do not learn from (e.g. a collection folder) are kept.', sw('replaceFolders')),
			row('Swap folder auto-tags', 'Removes the auto-tags of the folders the video leaves (and their parents) and adds those of the new folder. Tags you added yourself are kept.', sw('swapAutoTags')),
		] },
		{ id: 'fingerprints', title: 'Fingerprinting', icon: 'gpu', render: renderFingerprintSection },
		{ id: 'appearance', title: 'Appearance', icon: 'eye', render: () => [
			row('Interface size', null, range('uiScalePercent', '%')),
		] },
	];

	function renderFingerprintSection() {
		const cur = s().modelPath || paths.defaultModelPath();
		const st = app.status && app.status.model;
		return [
			row('Fingerprint new videos automatically', 'New videos are fingerprinted in the background (reads each video\'s Eagle thumbnail once).', sw('autoIndex')),
			row('Use the graphics card', 'Through DirectML. About 20 times faster than the CPU.', sw('useGpu')),
			row('Free graphics memory when idle', 'The model holds about 1 GB of video memory while loaded; it reloads in a second or two when needed.', sw('freeGpuWhenIdle')),
			row('Idle time before freeing it', null, num('idleUnloadSeconds', 'seconds')),
			row('Model file', h('span.mono.selectable', cur),
				h('div.row',
					h('span.badge' + (st && st.available ? '.good' : '.bad'), st && st.available ? 'found' : 'missing'),
					h('button.btn', { onclick: async () => {
						const r = await eagle.dialog.showOpenDialog({ title: 'Choose the fingerprint model', properties: ['openFile'], filters: [{ name: 'ONNX model', extensions: ['onnx'] }] });
						if (r && !r.canceled && r.filePaths && r.filePaths[0]) { set({ modelPath: r.filePaths[0] }); renderMain(); }
					} }, 'Choose…'),
					s().modelPath ? h('button.btn.ghost', { onclick: () => { set({ modelPath: '' }); renderMain(); } }, 'Default') : null)),
			row('Retry videos that failed', 'Videos whose thumbnail could not be read are skipped; try them again.', h('button.btn', { onclick: async () => { await app.engine.call('reindex', { all: false }); kit.toast('Retrying.'); } }, icon('refresh', 14), 'Retry')),
			row('Fingerprint everything again', 'Deletes the stored fingerprints of this library and starts over.', h('button.btn.danger', { onclick: async () => {
				if (!await kit.confirmDialog({ title: 'Start over?', message: 'All fingerprints of this library are deleted and made again. Suggestions pause until enough videos are done.', okLabel: 'Start over', danger: true })) return;
				await app.engine.call('reindex', { all: true });
				kit.toast('Fingerprinting from scratch.');
			} }, 'Start over')),
		];
	}

	function renderMain() {
		if (!mainEl) return;
		const top = mainEl.scrollTop;
		clear(mainEl);
		const sec = SECTIONS.find((x) => x.id === section);
		mainEl.append(h('div.set-section', h('h2', sec.title), ...[].concat(sec.render())));
		mainEl.scrollTop = top;
	}

	function render() {
		clear(el);
		const nav = h('div.settings-nav');
		for (const sec of SECTIONS) {
			nav.append(h(`div.nav-item${sec.id === section ? '.active' : ''}`, { onclick: () => { section = sec.id; render(); } }, icon(sec.icon, 16), h('span', sec.title)));
		}
		mainEl = h('div.settings-main');
		el.append(nav, mainEl);
		renderMain();
	}

	app.on('library', () => { if (app.current === 'settings') render(); });
	return { el, show: render, hide() {} };
}

module.exports = { create };
