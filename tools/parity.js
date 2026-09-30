// Check that the plugin's pipeline (pngjs + JS resize + ONNX on DirectML, inside Eagle's Node) gives the
// same fingerprints as the PyTorch test. Run: ELECTRON_RUN_AS_NODE=1 Eagle.exe tools/parity.js [model.onnx]
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const ort = require(path.join(ROOT, 'plugin', 'node_modules', 'onnxruntime-node'));
const { loadThumbnail, SIDE } = require(path.join(ROOT, 'plugin', 'js', 'engine', 'image.js'));

(async () => {
	const model = process.argv[2] || path.join(ROOT, 'models', 'pixai-v0.9-fingerprint-fp16.onnx');
	const files = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reference.json'), 'utf8'));
	const refBuf = fs.readFileSync(path.join(ROOT, 'data', 'reference.bin'));
	const ref = new Float32Array(refBuf.buffer, refBuf.byteOffset, refBuf.length / 4);
	for (const ep of (process.env.EPS || 'dml').split(',')) {
		let t0 = Date.now();
		const s = await ort.InferenceSession.create(model, { executionProviders: [ep] });
		const load = Date.now() - t0;
		t0 = Date.now();
		const imgs = [];
		for (const f of files) imgs.push(await loadThumbnail(f));
		const decode = (Date.now() - t0) / files.length;
		const cos = [];
		t0 = Date.now();
		for (let b = 0; b < files.length; b += 16) {
			const n = Math.min(16, files.length - b);
			const x = new Uint8Array(n * SIDE * SIDE * 3);
			for (let i = 0; i < n; i++) x.set(imgs[b + i], i * SIDE * SIDE * 3);
			const r = await s.run({ image: new ort.Tensor('uint8', x, [n, SIDE, SIDE, 3]) });
			const y = r.fingerprint.data;
			for (let i = 0; i < n; i++) {
				let dot = 0;
				for (let k = 0; k < 1024; k++) dot += y[i * 1024 + k] * ref[(b + i) * 1024 + k];
				cos.push(dot);
			}
		}
		const batched = (Date.now() - t0) / files.length;
		const one = new ort.Tensor('uint8', imgs[0], [1, SIDE, SIDE, 3]);
		await s.run({ image: one });
		t0 = Date.now();
		for (let i = 0; i < 10; i++) await s.run({ image: one });
		const single = (Date.now() - t0) / 10;
		cos.sort((a, b) => a - b);
		console.log(`${ep}: load ${load} ms, decode+resize ${decode.toFixed(1)} ms/img, batched ${batched.toFixed(1)} ms/img, `
			+ `single ${single.toFixed(1)} ms | cosine vs PyTorch: min ${cos[0].toFixed(4)} median ${cos[cos.length >> 1].toFixed(4)}`);
	}
})().catch((e) => { console.error(e); process.exit(1); });
