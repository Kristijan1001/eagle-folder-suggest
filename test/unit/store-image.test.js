'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { core, rng, PLUGIN } = require('../lib/helpers');

const { FingerprintStore } = core('engine/fpstore.js');
const image = core('engine/image.js');

function unit(seed) {
	const r = rng(seed);
	const v = new Float32Array(1024);
	let n = 0;
	for (let i = 0; i < 1024; i++) { v[i] = r.next() - 0.5; n += v[i] * v[i]; }
	for (let i = 0; i < 1024; i++) v[i] /= Math.sqrt(n);
	return v;
}
const cos = (a, b) => { let d = 0; for (let i = 0; i < 1024; i++) d += a[i] * b[i]; return d; };

test('fingerprint store: put, reload, overwrite, compact', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-store-'));
	try {
		const s = new FingerprintStore(dir);
		s.load();
		for (let i = 0; i < 50; i++) s.put(`ID${String(i).padStart(11, '0')}`, unit(i), i);
		s.put('ID00000000003', unit(999));          // overwrite
		s.flush();
		const t = new FingerprintStore(dir);
		assert.strictEqual(t.load().loaded, 50);
		assert.ok(cos(t.get('ID00000000007'), unit(7)) > 0.9999);
		assert.ok(cos(t.get('ID00000000003'), unit(999)) > 0.9999);
		assert.strictEqual(t.get('nope'), null);
		assert.strictEqual(t.garbage, 1);
		const kept = t.compact(new Set(['ID00000000001', 'ID00000000002']));
		assert.strictEqual(kept, 2);
		const u = new FingerprintStore(dir);
		assert.strictEqual(u.load().loaded, 2);
		assert.ok(cos(u.get('ID00000000002'), unit(2)) > 0.9999);
		assert.strictEqual(fs.statSync(path.join(dir, 'fingerprints.bin')).size, 8 + 2 * 1056);
		u.clear();
		assert.ok(!fs.existsSync(path.join(dir, 'fingerprints.bin')));
	}
	finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an unreadable store file is set aside, not crashed on', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-store-'));
	try {
		fs.writeFileSync(path.join(dir, 'fingerprints.bin'), 'garbage!');
		const s = new FingerprintStore(dir);
		assert.deepStrictEqual(s.load(), { loaded: 0, reset: true });
		assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('fingerprints.bin.unreadable')));
	}
	finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('resize taps are normalised and a same-size resize is the identity', () => {
	for (const [a, b] of [[711, 448], [400, 448], [1920, 448], [448, 448]]) {
		for (const t of image.taps(a, b)) assert.ok(Math.abs(t.w.reduce((x, y) => x + y, 0) - 1) < 1e-9);
	}
	const r = rng(4);
	const src = r.bytes(448 * 448 * 3);
	assert.deepStrictEqual(image.resizeRgb(src, 448, 448), src);
	const flat = new Uint8Array(711 * 400 * 3).fill(200);
	const out = image.resizeRgb(flat, 711, 400);
	assert.strictEqual(out.length, 448 * 448 * 3);
	assert.ok(out.every((v) => v === 200));
});

test('decoding: PNG with transparency goes on white; format sniffing', async () => {
	const { PNG } = require(path.join(PLUGIN, 'node_modules', 'pngjs'));
	const png = new PNG({ width: 2, height: 1 });
	png.data.set([255, 0, 0, 255, 0, 0, 0, 0]);
	const buf = PNG.sync.write(png);
	assert.strictEqual(image.kindOf(buf), 'png');
	const d = await image.decode(buf);
	assert.deepStrictEqual([...d.rgb], [255, 0, 0, 255, 255, 255]);
	assert.strictEqual(image.kindOf(Buffer.from('RIFF0000WEBPVP8 ')), 'webp');
	await assert.rejects(image.decode(Buffer.from('not an image at all')), /unsupported/);
});

test('decoding a real Eagle thumbnail (WebP), when the test data is there', async (t) => {
	const dir = path.resolve(PLUGIN, '..', 'data', 'thumbs');
	if (!fs.existsSync(dir)) { t.skip('no data/thumbs'); return; }
	const f = fs.readdirSync(dir)[0];
	const img = await image.loadThumbnail(path.join(dir, f));
	assert.strictEqual(img.length, 448 * 448 * 3);
});
