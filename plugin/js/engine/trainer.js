'use strict';
// Learning the folders: ridge regression on the fingerprints of already-sorted videos.
//
// Training runs twice: first without a held-back tenth of every folder, to measure how often the
// suggestions are right and pick the confidence at which they count as "sure" (for this library,
// not a guess); then on everything, for the model actually used.

const ridge = require('../core/ridge');
const { withTitle, topK, calibrate } = require('../core/suggest');
const { titleMatches } = require('../core/names');

const D = ridge.D;
const CHUNK = 4096;
const LAMBDA_REL = 0.003;   // lam = 0.003 * mean(diag G): the model test's best value (lam 0.01 at 7.6k videos)
const TEMP = 0.05;

function hashId(id) {
	let h = 2166136261;
	for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
	return h >>> 0;
}

/**
 * Fit W on examples [{id, cls}] (class indexes 0..C-1). weights: Float64Array(C) per-class weight.
 * Returns { W, L, lam }.
 */
async function fit(examples, C, weights, store, ops, pause) {
	const G = new Float64Array(D * D);
	const R = new Float64Array(C * D);
	const x = new Float32Array(1024);
	for (let s = 0; s < examples.length; s += CHUNK) {
		const part = examples.slice(s, s + CHUNK);
		const X = new Float32Array(part.length * D);
		let rows = 0;
		for (const ex of part) {
			if (!store.get(ex.id, x)) continue;
			const w = weights[ex.cls];
			const sw = Math.sqrt(w);
			const o = rows * D;
			const ro = ex.cls * D;
			for (let i = 0; i < 1024; i++) { X[o + i] = x[i] * sw; R[ro + i] += w * x[i]; }
			X[o + 1024] = sw;
			R[ro + 1024] += w;
			rows++;
		}
		if (!rows) continue;
		const g = await ops.gram(rows === part.length ? X : X.subarray(0, rows * D), rows, D);
		for (let i = 0; i < D * D; i++) G[i] += g[i];
		if (pause) await pause();
	}
	return ridge.solve(G, R, C, LAMBDA_REL, D);
}

/**
 * classes: [{ folderId, name, base }], examples: [{ id, name, cls }].
 * Returns the model (see predict) plus stats for the Overview page.
 */
async function train({ classes, examples, store, ops, target = 0.9, pause }) {
	const t0 = Date.now();
	const C = classes.length;
	const count = new Float64Array(C);
	for (const ex of examples) count[ex.cls]++;
	const weights = new Float64Array(C);
	for (let c = 0; c < C; c++) weights[c] = count[c] ? 1 / Math.sqrt(count[c]) : 0;
	const bases = new Map(classes.map((c, i) => [i, c.base]));

	// 1) held-back tenth of every folder with 5+ videos -> calibration
	const held = [];
	const fitSet = [];
	const heldPerClass = new Float64Array(C);
	for (const ex of examples) {
		const canHold = count[ex.cls] >= 5 && heldPerClass[ex.cls] < Math.floor(count[ex.cls] * 0.2);
		if (canHold && hashId(ex.id) % 10 === 3) { held.push(ex); heldPerClass[ex.cls]++; }
		else fitSet.push(ex);
	}
	let stats = calibrate([], target);
	if (held.length >= 30) {
		const w1 = new Float64Array(C);
		const cnt1 = new Float64Array(C);
		for (const ex of fitSet) cnt1[ex.cls]++;
		for (let c = 0; c < C; c++) w1[c] = cnt1[c] ? 1 / Math.sqrt(cnt1[c]) : 0;
		const m1 = await fit(fitSet, C, w1, store, ops, pause);
		const x = new Float32Array(1024);
		const evals = [];
		for (const ex of held) {
			if (!store.get(ex.id, x)) continue;
			const p0 = ridge.softmax(ridge.scores(m1.W, C, x), TEMP);
			const { probs } = withTitle(p0, titleMatches(ex.name, bases));
			const top = topK(probs, 3);
			evals.push({ conf: probs[top[0]], top1: top[0] === ex.cls, top3: top.includes(ex.cls) });
		}
		stats = calibrate(evals, target);
		if (pause) await pause();
	}

	// 2) the real model, on everything
	const m = await fit(examples, C, weights, store, ops, pause);
	const exampleOf = new Map();
	for (const ex of examples) {
		const prev = exampleOf.get(ex.id);
		exampleOf.set(ex.id, prev ? { cls: -1 } : { cls: ex.cls });   // cls -1: in several learned folders
	}
	return {
		classes, bases, weights, exampleOf,
		W: m.W, L: m.L, C,
		threshold: stats.threshold,
		stats: { ...stats, classes: C, examples: examples.length, trainedAt: Date.now(), ms: Date.now() - t0 },
	};
}

/**
 * Suggestions for one video. x: its fingerprint; name: its title.
 * Returns { ranked: [{ cls, prob }], sure, titleCls, loo }.
 */
function predict(model, id, name, x, k = 3) {
	let s = ridge.scores(model.W, model.C, x);
	const ex = model.exampleOf.get(id);
	let loo = false;
	if (ex && ex.cls >= 0) { s = ridge.leaveOneOut(s, model.L, x, model.weights[ex.cls], ex.cls); loo = true; }
	const p0 = ridge.softmax(s, TEMP);
	const { probs, title } = withTitle(p0, titleMatches(name, model.bases));
	const top = topK(probs, Math.min(k, model.C));
	return {
		ranked: top.map((c) => ({ cls: c, prob: probs[c] })),
		sure: probs[top[0]] >= model.threshold,
		titleCls: title,
		loo,
	};
}

module.exports = { train, predict, fit, hashId, TEMP, LAMBDA_REL };
