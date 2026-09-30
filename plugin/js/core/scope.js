'use strict';
// Which folders the plugin learns from (and so can suggest). Every folder is learned unless it,
// or its nearest parent with an explicit choice, is switched off; a choice on a folder covers its
// subfolders until one of them has its own. Folders: Map id -> { id, parent, children: [ids] }.

function isLearned(folderId, folders, choices) {
	let f = folders.get(folderId);
	const seen = new Set();
	while (f && !seen.has(f.id)) {
		seen.add(f.id);
		if (Object.prototype.hasOwnProperty.call(choices, f.id)) return !!choices[f.id];
		f = f.parent ? folders.get(f.parent) : null;
	}
	return true;
}

function learnedSet(folders, choices) {
	const out = new Set();
	for (const id of folders.keys()) if (isLearned(id, folders, choices)) out.add(id);
	return out;
}

/** Tree checkbox state: 'on' (it and everything below learned), 'off' (nothing), 'mixed'. */
function treeState(folderId, folders, learned) {
	let on = 0, off = 0;
	const stack = [folderId];
	const seen = new Set();
	while (stack.length) {
		const id = stack.pop();
		if (seen.has(id)) continue;
		seen.add(id);
		if (learned.has(id)) on++; else off++;
		if (on && off) return 'mixed';
		const f = folders.get(id);
		if (f) stack.push(...f.children);
	}
	return off ? 'off' : 'on';
}

/**
 * Clicking a folder's checkbox: switch it and its subfolders on or off, dropping the subfolders' own
 * choices so the click covers everything below. Returns the new choices object.
 */
function toggle(folderId, folders, choices, value) {
	const next = { ...choices };
	const stack = [...((folders.get(folderId) || {}).children || [])];
	const seen = new Set();
	while (stack.length) {
		const id = stack.pop();
		if (seen.has(id)) continue;
		seen.add(id);
		delete next[id];
		const f = folders.get(id);
		if (f) stack.push(...f.children);
	}
	const f = folders.get(folderId);
	const parentLearned = f && f.parent ? isLearned(f.parent, folders, next) : true;
	if (value === parentLearned) delete next[folderId]; else next[folderId] = value;
	return next;
}

module.exports = { isLearned, learnedSet, treeState, toggle };
