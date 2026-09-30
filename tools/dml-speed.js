// DirectML speed per session setup. Run: ELECTRON_RUN_AS_NODE=1 Eagle.exe tools/dml-speed.js
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const ort = require(path.join(ROOT, 'plugin', 'node_modules', 'onnxruntime-node'));
const model = path.join(ROOT, 'models', 'pixai-v0.9-fingerprint-fp16.onnx');
const S = 448 * 448 * 3;

(async () => {
	for (const n of [1, 4, 8, 16]) {
		const opts = { executionProviders: ['dml'], graphOptimizationLevel: 'all', enableMemPattern: false,
			executionMode: 'sequential', freeDimensionOverrides: { n } };
		let t0 = Date.now();
		const s = await ort.InferenceSession.create(model, opts);
		const load = Date.now() - t0;
		const x = new ort.Tensor('uint8', new Uint8Array(n * S).fill(128), [n, 448, 448, 3]);
		await s.run({ image: x });
		t0 = Date.now();
		const reps = Math.max(3, Math.round(32 / n));
		for (let i = 0; i < reps; i++) await s.run({ image: x });
		const per = (Date.now() - t0) / reps / n;
		console.log(`batch ${n}: load ${load} ms, ${per.toFixed(1)} ms per image`);
		await s.release();
	}
})().catch((e) => { console.error(e); process.exit(1); });
