'use strict';
// Fingerprints are stored as 1024 int8 values plus one float scale (1 KB per video instead of 4):
// a 68,000-video library fits in 70 MB and loads in a moment. The model outputs unit-length vectors,
// so symmetric max-abs quantisation keeps them within ~0.0001 cosine of the original.

const DIM = 1024;

function quantize(vec) {
	let max = 0;
	for (let i = 0; i < DIM; i++) { const a = Math.abs(vec[i]); if (a > max) max = a; }
	const scale = max / 127 || 1e-12;
	const q = new Int8Array(DIM);
	for (let i = 0; i < DIM; i++) q[i] = Math.max(-127, Math.min(127, Math.round(vec[i] / scale)));
	return { q, scale };
}

function dequantize(q, scale, out = new Float32Array(DIM)) {
	for (let i = 0; i < DIM; i++) out[i] = q[i] * scale;
	return out;
}

module.exports = { DIM, quantize, dequantize };
