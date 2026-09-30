'use strict';
// Stand-in for Eagle's plugin preloads over the fixture library. Mirrors the real API's shapes: Item
// instances with getters/setters and save(), fields-limited item.get, getIdsWithModifiedAt, folder
// trees without auto-tags (the real Folder model hides them too). The library state lives in a file
// in the harness's data folder, so the service window and the Inspector page see the same library.

const path = require('path');
const fs = require('fs');
const { ipcRenderer } = require('electron');

const root = path.resolve(__dirname, '..', '..');
const libraryPath = path.join(root, 'test', 'fixtures', 'library');
const stateFile = path.join(process.env.LOCALAPPDATA, 'mock-library-state.json');

global.require = (name) => (name === 'electron' ? {} : require(name));

function loadState() {
	if (!fs.existsSync(stateFile)) {
		const items = JSON.parse(fs.readFileSync(path.join(root, 'test', 'fixtures', 'items.json'), 'utf8'));
		const now = Date.now();
		fs.writeFileSync(stateFile, JSON.stringify({ items: items.map((it, i) => ({ ...it, isDeleted: false, lastModified: now - i, modificationTime: now - 86400000 - i, noThumbnail: it.ext === 'jpg' })), selected: [] }));
	}
	return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}
function saveState(s) { fs.writeFileSync(stateFile, JSON.stringify(s)); }

class Item {
	#o;
	constructor(o) { this.#o = { ...o, folders: [...(o.folders || [])], tags: [...(o.tags || [])] }; }
	get id() { return this.#o.id; }
	get name() { return this.#o.name; }
	get ext() { return this.#o.ext; }
	get tags() { return this.#o.tags; } set tags(v) { if (Array.isArray(v)) this.#o.tags = v; }
	get folders() { return this.#o.folders; } set folders(v) { if (Array.isArray(v)) this.#o.folders = v; }
	get isDeleted() { return this.#o.isDeleted; }
	get noThumbnail() { return !!this.#o.noThumbnail; }
	get modifiedAt() { return this.#o.lastModified; }
	get filePath() { return path.normalize(`${libraryPath}/images/${this.id}.info/${this.name}.${this.ext}`); }
	get thumbnailPath() { return this.noThumbnail ? this.filePath : path.normalize(`${libraryPath}/images/${this.id}.info/${this.name}_thumbnail.png`); }
	async save() {
		const s = loadState();
		const it = s.items.find((x) => x.id === this.id);
		it.folders = [...this.#o.folders];
		it.tags = [...this.#o.tags];
		it.lastModified = Date.now();
		saveState(s);
		window.__saves = (window.__saves || 0) + 1;
		await new Promise((r) => setTimeout(r, 5));
		return true;
	}
}

function itemGet(o = {}) {
	let list = loadState().items.filter((x) => !x.isDeleted);
	if (o.id) list = list.filter((x) => x.id === o.id);
	if (o.ids) list = list.filter((x) => o.ids.includes(x.id));
	if (o.isSelected) { const sel = loadState().selected; list = list.filter((x) => sel.includes(x.id)); }
	return list.map((x) => new Item(x));
}

function folderTree() {
	const meta = JSON.parse(fs.readFileSync(path.join(libraryPath, 'metadata.json'), 'utf8'));
	const conv = (f, parent) => ({ id: f.id, name: f.name, parent, iconColor: '', children: (f.children || []).map((c) => conv(c, f.id)) });
	return meta.folders.map((f) => conv(f, null));
}

const cb = { create: [], run: [], show: [], hide: [], exit: [], theme: [], library: [] };
const params = new URLSearchParams(location.search);

window.eagle = {
	onPluginCreate: (f) => cb.create.push(f),
	onPluginRun: (f) => cb.run.push(f),
	onPluginShow: (f) => cb.show.push(f),
	onPluginHide: (f) => cb.hide.push(f),
	onPluginBeforeExit: (f) => cb.exit.push(f),
	onThemeChanged: (f) => cb.theme.push(f),
	onLibraryChanged: (f) => cb.library.push(f),
	app: { theme: params.get('theme') || 'GRAY', version: '4.0.0', locale: 'en', platform: process.platform },
	library: { path: libraryPath },
	plugin: { path: path.join(root, 'plugin') },
	window: {
		minimize: () => ipcRenderer.invoke('harness.window', 'minimize'),
		maximize: () => ipcRenderer.invoke('harness.window', 'maximize'),
		unmaximize: () => ipcRenderer.invoke('harness.window', 'unmaximize'),
		isMaximized: () => ipcRenderer.invoke('harness.window', 'isMaximized'),
		hide: () => ipcRenderer.invoke('harness.window', 'hide'),
		show: () => ipcRenderer.invoke('harness.window', 'show'),
	},
	item: {
		get: async (o) => itemGet(o),
		getById: async (id) => itemGet({ id })[0],
		getByIds: async (ids) => itemGet({ ids }),
		getSelected: async () => itemGet({ isSelected: true }),
		getIdsWithModifiedAt: async () => loadState().items.filter((x) => !x.isDeleted).map((x) => ({ id: x.id, modifiedAt: x.lastModified })),
		select: async (ids) => { const s = loadState(); s.selected = [...ids]; saveState(s); return true; },
	},
	folder: { getAll: async () => folderTree() },
	dialog: {
		showOpenDialog: async (o) => (window.__dialogAnswers && window.__dialogAnswers.length ? window.__dialogAnswers.shift() : { canceled: true, filePaths: [] }),
		showSaveDialog: async () => ({ canceled: true }),
		showMessageBox: async () => ({ response: 0 }),
	},
	notification: { show: async () => true },
	clipboard: { writeText: (t) => { window.__clip = t; }, readText: () => window.__clip || '' },
	log: { debug: console.debug, info: console.info, warn: console.warn, error: console.error },
};
window.__mock = {
	theme: (t) => { window.eagle.app.theme = t; cb.theme.forEach((f) => f(t)); },
	state: loadState,
	moveOutside: (id, folders) => { const s = loadState(); const it = s.items.find((x) => x.id === id); it.folders = folders; it.lastModified = Date.now(); saveState(s); },
};
ipcRenderer.on('plugin-hide', () => cb.hide.forEach((f) => f()));
ipcRenderer.on('plugin-show', () => cb.show.forEach((f) => f()));

window.addEventListener('DOMContentLoaded', () => {
	setTimeout(() => {
		const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin', 'manifest.json'), 'utf8'));
		cb.create.forEach((f) => f({ manifest, path: path.join(root, 'plugin') }));
		cb.run.forEach((f) => f());
	}, 100);
});
