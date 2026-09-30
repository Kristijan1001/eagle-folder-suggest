'use strict';
// Settings: defaults, types and ranges. Folder choices are per library (folder ids differ).

const DEFAULTS = {
	// learning
	minVideosPerFolder: 3,          // a folder becomes a suggestion once it holds this many videos
	sureTargetPercent: 90,          // "sure" = right at least this often on held-back videos
	// moving
	replaceFolders: true,           // a move takes the video out of all its folders (Eagle's "Move to")
	swapAutoTags: true,             // swap the folder auto-tags on a move
	// suggestions
	suggestionCount: 3,
	// fingerprinting
	autoIndex: true,                // fingerprint new videos in the background
	useGpu: true,                   // DirectML; the CPU is ~20x slower
	freeGpuWhenIdle: true,
	idleUnloadSeconds: 120,
	modelPath: '',                  // '' = <data folder>\models\pixai-v0.9-fingerprint-fp16.onnx
	// sort view
	sortSource: 'unsorted',         // 'unsorted' | 'folder' | 'selection'
	sortFolderId: '',
	// per library: { [libraryKey]: { learn: { folderId: true|false } } }
	libraries: {},
	uiScalePercent: 100,
};

const RANGES = {
	minVideosPerFolder: [2, 50],
	sureTargetPercent: [70, 99],
	suggestionCount: [1, 5],
	idleUnloadSeconds: [15, 3600],
	uiScalePercent: [80, 150],
};

function normalize(s) {
	const out = { ...DEFAULTS };
	for (const [k, def] of Object.entries(DEFAULTS)) {
		const v = s ? s[k] : undefined;
		if (v === undefined || v === null) continue;
		if (typeof def === 'boolean') out[k] = !!v;
		else if (typeof def === 'number') {
			const n = Number(v);
			if (!Number.isFinite(n)) continue;
			const r = RANGES[k];
			out[k] = r ? Math.min(r[1], Math.max(r[0], Math.round(n))) : n;
		}
		else if (typeof def === 'string') out[k] = String(v);
		else if (k === 'libraries' && typeof v === 'object' && !Array.isArray(v)) {
			out.libraries = {};
			for (const [lk, lv] of Object.entries(v)) {
				const learn = {};
				for (const [fid, on] of Object.entries((lv && lv.learn) || {})) learn[fid] = !!on;
				out.libraries[lk] = { learn };
			}
		}
	}
	if (!['unsorted', 'folder', 'selection'].includes(out.sortSource)) out.sortSource = 'unsorted';
	return out;
}

function learnChoices(s, libKey) {
	return (s.libraries[libKey] && s.libraries[libKey].learn) || {};
}

/** Patch that sets one folder's learn choice (null = inherit from its parent). */
function withLearnChoice(s, libKey, folderId, value) {
	const libraries = { ...s.libraries };
	const learn = { ...learnChoices(s, libKey) };
	if (value === null) delete learn[folderId]; else learn[folderId] = !!value;
	libraries[libKey] = { learn };
	return { libraries };
}

module.exports = { DEFAULTS, RANGES, normalize, learnChoices, withLearnChoice };
