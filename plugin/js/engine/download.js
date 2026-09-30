'use strict';
// First-run download of the fingerprint model (only after the user agrees on the Overview page).
// The file comes from the project's GitHub release and must match a fixed SHA-256 before it is used;
// it is written next to the settings (never into the plugin folder or the Eagle library).

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const MODEL = {
	file: 'pixai-v0.9-fingerprint-fp16.onnx',
	size: 620746839,
	sha256: '409d1f83ae8604c347893627dc096e2e17e36b345aabb42cf8885acad1d4c1eb',
	urls: ['https://github.com/Kristijan1001/eagle-folder-suggest/releases/download/v1.0.0/pixai-v0.9-fingerprint-fp16.onnx'],
};

function fetchTo(url, file, onProgress, signal, redirects = 0) {
	return new Promise((resolve, reject) => {
		const req = https.get(url, { headers: { 'User-Agent': 'Folder-Suggest-for-Eagle' } }, (res) => {
			if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
				res.resume();
				if (redirects > 5) { reject(new Error('Too many redirects')); return; }
				resolve(fetchTo(new URL(res.headers.location, url).href, file, onProgress, signal, redirects + 1));
				return;
			}
			if (res.statusCode !== 200) { res.resume(); reject(new Error(`Download failed (HTTP ${res.statusCode})`)); return; }
			const total = Number(res.headers['content-length']) || MODEL.size;
			const hash = crypto.createHash('sha256');
			const out = fs.createWriteStream(file);
			let got = 0;
			let last = 0;
			res.on('data', (chunk) => {
				got += chunk.length;
				hash.update(chunk);
				const now = Date.now();
				if (now - last > 250) { last = now; onProgress(got, total); }
			});
			res.pipe(out);
			const fail = (err) => { out.destroy(); out.once('close', () => reject(err)); };
			res.on('error', fail);
			res.on('aborted', () => fail(new Error(signal && signal.aborted ? 'Download cancelled.' : 'The connection was lost.')));
			out.on('error', reject);
			out.on('finish', () => { onProgress(got, total); resolve({ got, sha256: hash.digest('hex') }); });
		});
		req.on('error', reject);
		req.setTimeout(60000, () => req.destroy(new Error('The download stalled.')));
		if (signal) signal.abort = () => { signal.aborted = true; req.destroy(new Error('Download cancelled.')); };
	});
}

/** Download the model into dir; resolves with its path once verified. signal: { aborted, abort } set here. */
async function downloadModel(dir, onProgress, signal) {
	fs.mkdirSync(dir, { recursive: true });
	const dest = path.join(dir, MODEL.file);
	const part = `${dest}.part`;
	let lastErr = null;
	for (const url of MODEL.urls) {
		try {
			const r = await fetchTo(url, part, onProgress, signal);
			if (r.sha256 !== MODEL.sha256) throw new Error('The downloaded file did not match its checksum and was discarded.');
			fs.renameSync(part, dest);
			return dest;
		}
		catch (err) {
			lastErr = err;
			try { fs.unlinkSync(part); } catch { /* none */ }
			if (signal && signal.aborted) break;
		}
	}
	throw lastErr || new Error('Download failed.');
}

module.exports = { MODEL, downloadModel };
