'use strict';
// Folder names and video titles: the "title contains the folder name" signal.
// A folder like "Tifa Lockhart - FF" is known by its base name "tifa lockhart" (the part before
// " - "); a title matches when that base name appears in it as whole words.

function norm(s) {
	return String(s || '')
		.toLowerCase()
		.replace(/_/g, ' ')
		.replace(/[^\p{L}\p{N}.' ]+/gu, ' ')
		.replace(/(^|\s)[.']+|[.']+(?=\s|$)/g, ' ')   // dots/apostrophes only count inside words ("d.va", "y'shtola")
		.replace(/\s+/g, ' ')
		.trim();
}

/** 'Tifa Lockhart - FF' -> 'tifa lockhart'; '.Others - Final Fantasy - FF' -> '' (catch-all, no name). */
function folderBase(name) {
	const raw = String(name || '').trim();
	if (raw.startsWith('.') || raw.startsWith('_')) return '';
	return norm(raw.split(/\s+-\s+/)[0]);
}

/**
 * Folders whose base name appears in the title as whole words.
 * bases: Map folderId -> base name (from folderBase). Returns the ids of the longest matching names
 * (a title saying "Kyrie Canaan" prefers "Kyrie Canaan" over "Kyrie"); several ids when names tie.
 */
function titleMatches(title, bases) {
	const t = ` ${norm(title)} `;
	let best = 0;
	let ids = [];
	for (const [id, base] of bases) {
		if (!base || base.length < 2) continue;
		if (!t.includes(` ${base} `)) continue;
		if (base.length > best) { best = base.length; ids = [id]; }
		else if (base.length === best) ids.push(id);
	}
	return ids;
}

module.exports = { norm, folderBase, titleMatches };
