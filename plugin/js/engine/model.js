'use strict';
// ONNX Runtime sessions: the fingerprint model (PixAI v0.9's EVA02-Large body, on the GPU through
// DirectML) and two tiny CPU graphs for the ridge training maths (models/gram.onnx, matmul.onnx).
//
// The fingerprint model holds ~1 GB of video memory while loaded, so it is released after a spell
// of no work (settings: freeGpuWhenIdle / idleUnloadSeconds) and reloaded in ~1.5 s when needed.

const fs = require('fs');
const path = require('path');

let ort = null;
function runtime() {
	if (!ort) ort = require('onnxruntime-node');
	return ort;
}

const SIDE = 448;
const DIM = 1024;

class FingerprintModel {
	constructor({ log }) {
		this.log = log || (() => {});
		this.session = null;
		this.loading = null;
		this.ep = '';
		this.error = '';
		this.modelPath = '';
		this.useGpu = true;
		this.idleMs = 120000;
		this.freeWhenIdle = true;
		this.idleTimer = null;
		this.queue = Promise.resolve();
		this.busy = 0;
		this.runs = 0;
	}

	configure({ modelPath, useGpu, freeGpuWhenIdle, idleUnloadSeconds }) {
		const changed = modelPath !== this.modelPath || useGpu !== this.useGpu;
		this.modelPath = modelPath;
		this.useGpu = !!useGpu;
		this.freeWhenIdle = !!freeGpuWhenIdle;
		this.idleMs = Math.max(15, idleUnloadSeconds || 120) * 1000;
		if (changed) { this.error = ''; this.release(); }
	}

	get available() { return !!this.modelPath && fs.existsSync(this.modelPath); }
	get loaded() { return !!this.session; }

	async ensure() {
		if (this.session) return this.session;
		if (this.loading) return this.loading;
		if (!this.available) throw new Error(`Model file not found: ${this.modelPath || '(not set)'}`);
		this.loading = (async () => {
			const rt = runtime();
			const tries = this.useGpu ? ['dml', 'cpu'] : ['cpu'];
			let lastErr = null;
			for (const ep of tries) {
				try {
					const t0 = Date.now();
					const opts = ep === 'dml'
						? { executionProviders: ['dml'], graphOptimizationLevel: 'all', enableMemPattern: false, executionMode: 'sequential', logSeverityLevel: 3 }
						: { executionProviders: ['cpu'], graphOptimizationLevel: 'all', logSeverityLevel: 3 };
					const s = await rt.InferenceSession.create(this.modelPath, opts);
					this.session = s;
					this.ep = ep;
					this.error = '';
					this.log('info', `Fingerprint model loaded on the ${ep === 'dml' ? 'GPU (DirectML)' : 'CPU'} in ${Date.now() - t0} ms.`);
					return s;
				}
				catch (err) {
					lastErr = err;
					this.log('warn', `Loading the model on ${ep} failed: ${String(err.message || err).split('\n')[0]}`);
				}
			}
			this.error = String(lastErr && lastErr.message || lastErr).split('\n')[0];
			throw lastErr;
		})();
		try { return await this.loading; }
		finally { this.loading = null; }
	}

	/** Fingerprints for 448x448 RGB images (Uint8Array each) -> Float32Array(1024) each, unit length. */
	embed(images) {
		const job = this.queue.then(async () => {
			this.busy++;
			clearTimeout(this.idleTimer);
			try {
				const s = await this.ensure();
				const rt = runtime();
				const n = images.length;
				const x = new Uint8Array(n * SIDE * SIDE * 3);
				for (let i = 0; i < n; i++) x.set(images[i], i * SIDE * SIDE * 3);
				const r = await s.run({ image: new rt.Tensor('uint8', x, [n, SIDE, SIDE, 3]) });
				const y = r.fingerprint.data;
				this.runs += n;
				const out = [];
				for (let i = 0; i < n; i++) out.push(Float32Array.from(y.subarray(i * DIM, (i + 1) * DIM)));
				return out;
			}
			finally {
				this.busy--;
				this.armIdle();
			}
		});
		this.queue = job.catch(() => {});
		return job;
	}

	armIdle() {
		clearTimeout(this.idleTimer);
		if (!this.freeWhenIdle || !this.session) return;
		this.idleTimer = setTimeout(() => {
			if (this.busy) return;
			this.log('info', 'Fingerprint model released (idle).');
			this.release();
		}, this.idleMs);
	}

	release() {
		clearTimeout(this.idleTimer);
		const s = this.session;
		this.session = null;
		this.ep = '';
		if (s) { try { s.release(); } catch { /* ignore */ } }
	}

	status() {
		return { available: this.available, loaded: this.loaded, ep: this.ep, error: this.error, path: this.modelPath, runs: this.runs };
	}
}

/** CPU matrix products through ONNX Runtime (multithreaded BLAS-grade speed from Node). */
class MatOps {
	constructor(modelsDir) {
		this.modelsDir = modelsDir;
		this.gramS = null;
		this.mmS = null;
	}

	async session(name) {
		const rt = runtime();
		if (name === 'gram') return this.gramS || (this.gramS = await rt.InferenceSession.create(path.join(this.modelsDir, 'gram.onnx'), { executionProviders: ['cpu'], logSeverityLevel: 3 }));
		return this.mmS || (this.mmS = await rt.InferenceSession.create(path.join(this.modelsDir, 'matmul.onnx'), { executionProviders: ['cpu'], logSeverityLevel: 3 }));
	}

	/** x: Float32Array(n*d) row-major -> Float32Array(d*d) = x' x */
	async gram(x, n, d) {
		const rt = runtime();
		const s = await this.session('gram');
		const r = await s.run({ x: new rt.Tensor('float32', x, [n, d]) });
		return r.g.data;
	}

	/** a: (n x k), b: (k x m), row-major -> (n x m) */
	async matmul(a, n, k, b, m) {
		const rt = runtime();
		const s = await this.session('mm');
		const r = await s.run({ a: new rt.Tensor('float32', a, [n, k]), b: new rt.Tensor('float32', b, [k, m]) });
		return r.c.data;
	}
}

module.exports = { FingerprintModel, MatOps, SIDE, DIM };
