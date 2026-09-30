'use strict';
// Eagle thumbnail -> 448x448 RGB bytes for the fingerprint model.
// Eagle 4 writes thumbnails as WebP even though they are named *_thumbnail.png; PNG is kept for older ones.
// Matches the test that picked the model: transparency becomes white (PixAI's pil_to_rgb) and the
// resize is PIL's BILINEAR (a triangle filter that widens when shrinking), done per axis.

const fs = require('fs');
const { PNG } = require('pngjs');
const WebP = require('node-webpmux');

const SIDE = 448;
let webpReady = null;

function kindOf(buf) {
	if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
	if (buf.length > 8 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'png';
	return 'unknown';
}

/** Image bytes (WebP or PNG) -> { width, height, rgb: Uint8Array } with alpha composited over white. */
async function decode(buf) {
	const kind = kindOf(buf);
	if (kind === 'png') {
		const png = PNG.sync.read(buf);
		return rgbaToRgb(png.width, png.height, png.data);
	}
	if (kind === 'webp') {
		if (!webpReady) webpReady = WebP.Image.initLib();
		await webpReady;
		const img = new WebP.Image();
		await img.load(buf);
		return rgbaToRgb(img.width, img.height, await img.getImageData());
	}
	throw new Error('unsupported thumbnail format');
}

function rgbaToRgb(width, height, data) {
	const rgb = new Uint8Array(width * height * 3);
	for (let p = 0, q = 0; p < data.length; p += 4, q += 3) {
		const a = data[p + 3];
		if (a === 255) {
			rgb[q] = data[p]; rgb[q + 1] = data[p + 1]; rgb[q + 2] = data[p + 2];
		}
		else {
			const k = a / 255;
			rgb[q] = Math.round(data[p] * k + 255 * (1 - k));
			rgb[q + 1] = Math.round(data[p + 1] * k + 255 * (1 - k));
			rgb[q + 2] = Math.round(data[p + 2] * k + 255 * (1 - k));
		}
	}
	return { width, height, rgb };
}

/** Per-output-pixel tap lists for PIL's bilinear filter along one axis. */
function taps(inSize, outSize) {
	const scale = inSize / outSize;
	const filterScale = Math.max(scale, 1);
	const support = filterScale;             // bilinear support 1.0, widened when shrinking
	const out = [];
	for (let i = 0; i < outSize; i++) {
		const center = (i + 0.5) * scale;
		const lo = Math.max(0, Math.floor(center - support + 0.5));
		const hi = Math.min(inSize, Math.floor(center + support + 0.5));
		const w = [];
		let sum = 0;
		for (let x = lo; x < hi; x++) {
			const v = Math.max(0, 1 - Math.abs((x - center + 0.5) / filterScale));
			w.push(v);
			sum += v;
		}
		for (let k = 0; k < w.length; k++) w[k] /= sum || 1;
		out.push({ lo, w });
	}
	return out;
}

/** Resize packed RGB to side x side (the model's input is a stretched square, like the test). */
function resizeRgb(src, width, height, side = SIDE) {
	const tx = taps(width, side);
	const ty = taps(height, side);
	const mid = new Float32Array(side * height * 3);         // horizontal pass
	for (let y = 0; y < height; y++) {
		const row = y * width * 3;
		for (let x = 0; x < side; x++) {
			const { lo, w } = tx[x];
			let r = 0, g = 0, b = 0;
			for (let k = 0; k < w.length; k++) {
				const s = row + (lo + k) * 3;
				r += src[s] * w[k]; g += src[s + 1] * w[k]; b += src[s + 2] * w[k];
			}
			const d = (y * side + x) * 3;
			mid[d] = r; mid[d + 1] = g; mid[d + 2] = b;
		}
	}
	const out = new Uint8Array(side * side * 3);              // vertical pass
	for (let y = 0; y < side; y++) {
		const { lo, w } = ty[y];
		for (let x = 0; x < side; x++) {
			let r = 0, g = 0, b = 0;
			for (let k = 0; k < w.length; k++) {
				const s = ((lo + k) * side + x) * 3;
				r += mid[s] * w[k]; g += mid[s + 1] * w[k]; b += mid[s + 2] * w[k];
			}
			const d = (y * side + x) * 3;
			out[d] = clamp(r); out[d + 1] = clamp(g); out[d + 2] = clamp(b);
		}
	}
	return out;
}

function clamp(v) { return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v); }

/** Thumbnail file -> Uint8Array(448*448*3), or throws. */
async function loadThumbnail(file) {
	const buf = await fs.promises.readFile(file);
	const { width, height, rgb } = await decode(buf);
	return resizeRgb(rgb, width, height);
}

module.exports = { SIDE, decode, kindOf, resizeRgb, taps, loadThumbnail };
