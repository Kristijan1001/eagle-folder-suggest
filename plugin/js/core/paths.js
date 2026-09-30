'use strict';
// Where the plugin keeps its data: outside the plugin folder (replaced on updates) and outside the
// Eagle library (Eagle asks plugins not to write there). Settings are global, fingerprints per library.

const path = require('path');
const os = require('os');
const crypto = require('crypto');

const APP = 'Folder Suggest';
const MODEL_FILE = 'pixai-v0.9-fingerprint-fp16.onnx';

function dataRoot() {
	if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), APP);
	if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', APP);
	return path.join(os.homedir(), '.folder-suggest');
}

// Eagle hands the library path over normalised at start-up but raw on library-changed.
function normalizeLibraryPath(p) {
	return p ? path.normalize(String(p)).replace(/(.)[\\/]+$/, '$1') : '';
}
function sameLibrary(a, b) {
	return normalizeLibraryPath(a).toLowerCase() === normalizeLibraryPath(b).toLowerCase();
}
function libraryKey(libraryPath) {
	const p = normalizeLibraryPath(libraryPath);
	const base = path.basename(p || 'library').replace(/\.library$/i, '').replace(/[^\w\- ]+/g, '_').slice(0, 40) || 'library';
	const hash = crypto.createHash('sha1').update(p.toLowerCase()).digest('hex').slice(0, 8);
	return `${base}-${hash}`;
}

function libraryDir(libraryPath) { return path.join(dataRoot(), 'libraries', libraryKey(libraryPath)); }
function defaultModelPath() { return path.join(dataRoot(), 'models', MODEL_FILE); }
function engineFile() { return path.join(dataRoot(), 'engine.json'); }

module.exports = { APP, MODEL_FILE, dataRoot, normalizeLibraryPath, sameLibrary, libraryKey, libraryDir, defaultModelPath, engineFile };
