'use strict';
// Builds the installable .eagleplugin from plugin/ into dist/.
//
//   node tools/pack.js
//
// A .eagleplugin is a zip with manifest.json at its root. Windows x64 only (the model runs on DirectML).
// Only what runs goes in: the plugin's own files, the runtime packages (onnxruntime-node with just its
// win32/x64 binaries, onnxruntime-common, node-webpmux, pngjs) and the two tiny helper models. The
// fingerprint model is never packed: the plugin downloads it from the release on first use.
// No dependencies: the zip writer below uses zlib only, so this runs on plain Node or Eagle.exe as Node.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.resolve(__dirname, '..');
const pluginDir = path.join(root, 'plugin');
const distDir = path.join(root, 'dist');

const TARGETS = {
	'win-x64': { platform: 'win', arch: 'x64', bins: ['win32/x64'] },
};

const ORT_BIN = 'node_modules/onnxruntime-node/bin/napi-v6/';
const RUNTIME = ['onnxruntime-node', 'onnxruntime-common', 'node-webpmux', 'pngjs'];   // what the plugin loads at run time
const HELPER_MODELS = ['models/gram.onnx', 'models/matmul.onnx'];

function include(rel, target) {
	const r = rel.replace(/\\/g, '/');
	if (r === 'package-lock.json' || r === 'node_modules/.package-lock.json') return false;
	if (r.endsWith('.map')) return false;
	if (r.startsWith('models/')) return HELPER_MODELS.includes(r);
	if (r.startsWith('node_modules/')) {
		if (!RUNTIME.includes(r.split('/')[1])) return false;                              // installer-only dependencies
		if (/^node_modules\/onnxruntime-(node|common)\/(lib|script)\//.test(r)) return false; // TypeScript sources, install script
		if (/^node_modules\/node-webpmux\/(examples\.js|bin\/)/.test(r)) return false;
		if (r.startsWith(ORT_BIN)) return target.bins.some((b) => r.startsWith(ORT_BIN + b + '/'));
	}
	return true;
}

function walk(dir, base = dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.name === '.git' || e.name === '.DS_Store' || e.name === 'Thumbs.db') continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p, base, out);
		else if (e.isFile()) out.push(path.relative(base, p));
	}
	return out;
}

// ── minimal zip writer (deflate, UTF-8 names, no zip64: < 4 GB and < 65535 entries) ──
const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
	return t;
})();
function crc32(buf) {
	let c = 0xFFFFFFFF;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
	return (c ^ 0xFFFFFFFF) >>> 0;
}
function dosTime(d) {
	const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
	const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
	return { time, date };
}

function writeZip(file, entries) {
	const chunks = [];
	const central = [];
	let offset = 0;
	for (const { name, data, mtime } of entries) {
		const nameBuf = Buffer.from(name, 'utf8');
		const crc = crc32(data);
		let body = zlib.deflateRawSync(data, { level: 9 });
		let method = 8;
		if (body.length >= data.length) { body = data; method = 0; } // store what does not shrink
		const { time, date } = dosTime(mtime);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
		local.writeUInt16LE(method, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
		local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
		chunks.push(local, nameBuf, body);
		const cd = Buffer.alloc(46);
		cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8);
		cd.writeUInt16LE(method, 10); cd.writeUInt16LE(time, 12); cd.writeUInt16LE(date, 14);
		cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(data.length, 24);
		cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
		cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(offset, 42);
		central.push(cd, nameBuf);
		offset += local.length + nameBuf.length + body.length;
	}
	const cdBuf = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
	end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, Buffer.concat([...chunks, cdBuf, end]));
	fs.renameSync(tmp, file);
}

function pack(targetName) {
	const target = TARGETS[targetName];
	if (!target) throw new Error(`Unknown target "${targetName}" (${Object.keys(TARGETS).join(', ')})`);
	const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));
	if (manifest.devTools) throw new Error('manifest.json has devTools: true — switch it off before packaging.');
	const files = walk(pluginDir).filter((rel) => include(rel, target)).sort();
	for (const b of target.bins) {
		if (!files.some((f) => f.replace(/\\/g, '/').startsWith(`${ORT_BIN}${b}/`))) throw new Error(`onnxruntime binaries for ${b} are missing (run: cd plugin && npm install).`);
	}
	const entries = files.map((rel) => {
		const abs = path.join(pluginDir, rel);
		let data = fs.readFileSync(abs);
		if (rel === 'manifest.json') data = Buffer.from(JSON.stringify({ ...manifest, platform: target.platform, arch: target.arch }, null, '\t') + '\n');
		return { name: rel.replace(/\\/g, '/'), data, mtime: fs.statSync(abs).mtime };
	});
	fs.mkdirSync(distDir, { recursive: true });
	const out = path.join(distDir, `${manifest.name} ${manifest.version} (${targetName}).eagleplugin`);
	writeZip(out, entries);
	const size = fs.statSync(out).size;
	console.log(`${path.relative(root, out)}  ${entries.length} files, ${(size / 1048576).toFixed(1)} MB`);
	return out;
}

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
for (const t of (wanted.length ? wanted : ['win-x64'])) pack(t);
