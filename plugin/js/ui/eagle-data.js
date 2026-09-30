'use strict';
// Everything that talks to Eagle from the service page: the library's folders (with their auto-tags)
// and items for the engine, change detection, and applying moves / undos through the plugin API.
//
// Folder auto-tags are not in Eagle's plugin API (the Folder model's tags getter is disabled), so
// they are read from the library's metadata.json. That file is only ever read.

const fs = require('fs');
const path = require('path');
const { sameSet } = require('../core/moves');

const ITEM_FIELDS = ['id', 'name', 'ext', 'folders', 'tags', 'noThumbnail', 'lastModified'];

function plain(it) {
	return { id: it.id, name: it.name, ext: it.ext, folders: [...(it.folders || [])], tags: [...(it.tags || [])], noThumbnail: !!it.noThumbnail };
}

class EagleData {
	constructor(log) {
		this.log = log || (() => {});
		this.folders = new Map();      // id -> { id, name, parent, children, tags, iconColor, path }
		this.roots = [];
		this.items = new Map();        // id -> plain item
		this.modified = new Map();     // id -> modifiedAt
		this.metaMtime = 0;
	}

	get libraryPath() { return eagle.library.path; }
	get libraryName() { return path.basename(eagle.library.path || '').replace(/\.library$/i, '') || 'Library'; }

	/** metadata.json folder tree -> Map id -> auto-tags (read only). */
	readAutoTags() {
		const file = path.join(this.libraryPath, 'metadata.json');
		const out = new Map();
		try {
			const st = fs.statSync(file);
			this.metaMtime = st.mtimeMs;
			const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
			const walk = (list) => { for (const f of list || []) { out.set(f.id, Array.isArray(f.tags) ? f.tags : []); walk(f.children); } };
			walk(meta.folders);
		}
		catch (err) { this.log('warn', `Could not read folder auto-tags: ${err.message}`); }
		return out;
	}

	async loadFolders() {
		const all = await eagle.folder.getAll();
		const tags = this.readAutoTags();
		this.folders.clear();
		this.roots = [];
		const visit = (f, parent, parentPath) => {
			if (!f || !f.id || this.folders.has(f.id)) return;
			const node = { id: f.id, name: f.name || '(unnamed)', parent, children: [], tags: tags.get(f.id) || [], iconColor: f.iconColor || '', path: parentPath ? `${parentPath} / ${f.name}` : f.name };
			this.folders.set(f.id, node);
			if (parent && this.folders.has(parent)) this.folders.get(parent).children.push(f.id); else this.roots.push(f.id);
			for (const c of f.children || []) visit(c, f.id, node.path);
		};
		for (const f of all) if (!f.parent) visit(f, null, '');
		for (const f of all) if (!this.folders.has(f.id)) visit(f, f.parent && this.folders.has(f.parent) ? f.parent : null, '');
		return this.folders;
	}

	folderList() {
		return [...this.folders.values()].map((f) => ({ id: f.id, name: f.name, parent: f.parent, tags: f.tags }));
	}

	async loadItems() {
		const items = await eagle.item.get({ fields: ITEM_FIELDS });
		this.items.clear();
		this.modified.clear();
		for (const it of items) {
			this.items.set(it.id, plain(it));
			this.modified.set(it.id, it.modifiedAt || 0);
		}
		return [...this.items.values()];
	}

	/** Items added, changed or removed since the last look. */
	async changes() {
		const now = await eagle.item.getIdsWithModifiedAt();
		const seen = new Set();
		const changed = [];
		for (const { id, modifiedAt } of now) {
			seen.add(id);
			if (this.modified.get(id) !== modifiedAt) changed.push(id);
			this.modified.set(id, modifiedAt);
		}
		const removed = [];
		for (const id of this.items.keys()) if (!seen.has(id)) removed.push(id);
		for (const id of removed) { this.items.delete(id); this.modified.delete(id); }
		const upsert = [];
		for (let i = 0; i < changed.length; i += 400) {
			for (const it of await eagle.item.getByIds(changed.slice(i, i + 400))) {
				if (it.isDeleted) { if (this.items.delete(it.id)) removed.push(it.id); continue; }
				const p = plain(it);
				this.items.set(it.id, p);
				upsert.push(p);
			}
		}
		return { upsert, removed };
	}

	/** Did the folder structure or its auto-tags change (metadata.json rewritten)? */
	foldersMaybeChanged() {
		try { return fs.statSync(path.join(this.libraryPath, 'metadata.json')).mtimeMs !== this.metaMtime; }
		catch { return false; }
	}

	/**
	 * Move one video to a folder: the engine plans folders + tags (settings, auto-tags), the API saves.
	 * Returns the move record the engine keeps for Undo.
	 */
	async move(engine, id, target, { source = 'sort', batch = null } = {}) {
		const item = await eagle.item.getById(id);
		if (!item) throw new Error('The video is no longer in the library.');
		const before = { folders: [...(item.folders || [])], tags: [...(item.tags || [])] };
		const plan = await engine.call('plan', { item: { id, ...before }, target });
		item.folders = plan.folders;
		item.tags = plan.tags;
		await item.save();
		const after = { folders: [...plan.folders], tags: [...plan.tags] };
		const rec = { id, name: item.name, before, after, target, source, batch };
		await engine.call('moved', rec);
		this.items.set(id, { ...(this.items.get(id) || plain(item)), folders: after.folders, tags: after.tags });
		return rec;
	}

	/**
	 * Undo moves (a single move or a batch). Only items still where the move put them are touched;
	 * tags added or removed by the move are reverted, other tag edits are kept.
	 */
	async undo(engine, entries) {
		let restored = 0;
		const skipped = [];
		for (const e of [...entries].reverse()) {
			const item = await eagle.item.getById(e.id);
			if (!item) { skipped.push(e.name); continue; }
			if (!sameSet(item.folders, e.after.folders)) { skipped.push(e.name); continue; }
			const added = e.after.tags.filter((t) => !e.before.tags.includes(t));
			const removed = e.before.tags.filter((t) => !e.after.tags.includes(t));
			const tags = (item.tags || []).filter((t) => !added.includes(t));
			for (const t of removed) if (!tags.includes(t)) tags.push(t);
			item.folders = [...e.before.folders];
			item.tags = tags;
			await item.save();
			this.items.set(e.id, { ...(this.items.get(e.id) || plain(item)), folders: [...e.before.folders], tags });
			restored++;
		}
		await engine.call('undone', entries.length > 1 && entries[0].batch ? { batch: entries[0].batch } : { ids: entries.map((e) => e.id) });
		return { restored, skipped };
	}
}

module.exports = { EagleData, ITEM_FIELDS, plain };
