'use strict';
// What a move changes on an item: its folders and, optionally, the folder auto-tags.
//
// Eagle's own "move to folder" adds a folder's auto-tags, but a plugin's item.save() stores only
// the folders and tags it is given (Eagle 4, app 'item.save' handler), so the plugin applies them:
// the auto-tags of the old folders and their parents that the new folder chain does not carry are
// removed, and the new chain's are added. Tags the user added by hand are never touched.

/**
 * Auto-tags of a folder and all its parents.
 * folders: Map id -> { parent, tags: [] }
 */
function chainTags(folderId, folders) {
	const out = [];
	const seen = new Set();
	let f = folders.get(folderId);
	while (f && !seen.has(f.id)) {
		seen.add(f.id);
		for (const t of f.tags || []) if (!out.includes(t)) out.push(t);
		f = f.parent ? folders.get(f.parent) : null;
	}
	return out;
}

/**
 * item: { folders: [ids], tags: [names] }; target: folder id.
 * opts.replaceFolders: true = the item leaves all its folders (Eagle's "move"), false = it leaves
 *   only folders inside the learned set (keepFolder(id) === false) and keeps the others.
 * opts.swapTags: update auto-tags as described above.
 * Returns { folders, tags, removedTags, addedTags }.
 */
function planMove(item, target, folders, opts = {}) {
	const { replaceFolders = true, swapTags = true, keepFolder = () => false } = opts;
	const oldFolders = item.folders || [];
	const kept = replaceFolders ? [] : oldFolders.filter((f) => f !== target && keepFolder(f));
	const newFolders = [...kept, target];
	let tags = [...(item.tags || [])];
	let removedTags = [];
	let addedTags = [];
	if (swapTags) {
		const newChain = new Set(chainTags(target, folders));
		for (const f of kept) for (const t of chainTags(f, folders)) newChain.add(t);
		const oldChain = new Set();
		for (const f of oldFolders) for (const t of chainTags(f, folders)) oldChain.add(t);
		removedTags = tags.filter((t) => oldChain.has(t) && !newChain.has(t));
		tags = tags.filter((t) => !removedTags.includes(t));
		addedTags = [...newChain].filter((t) => !tags.includes(t));
		tags = [...tags, ...addedTags];
	}
	return { folders: newFolders, tags, removedTags, addedTags };
}

function sameSet(a, b) {
	const A = new Set(a || []);
	const B = new Set(b || []);
	if (A.size !== B.size) return false;
	for (const x of A) if (!B.has(x)) return false;
	return true;
}

module.exports = { chainTags, planMove, sameSet };
