'use strict';
// From model probabilities (+ the title check) to ranked folder suggestions, and the calibration
// that decides when a suggestion counts as "sure".

/**
 * Put the title's folder first: when the title names one of the folders, that folder wins (the
 * test showed titles are right ~89% of the time when they name a folder) and the model's own
 * picks follow as runners-up. With several same-length name matches (e.g. two "Raven" folders)
 * the model picks among them.
 * probs: Float64Array over classes; titleIdx: class indexes named by the title.
 */
function withTitle(probs, titleIdx) {
	if (!titleIdx || !titleIdx.length) return { probs, title: -1 };
	let t = titleIdx[0];
	for (const i of titleIdx) if (probs[i] > probs[t]) t = i;
	const out = new Float64Array(probs.length);
	let sum = 0;
	for (let i = 0; i < probs.length; i++) { out[i] = i === t ? 1 : probs[i] * 0.5; sum += out[i]; }
	for (let i = 0; i < out.length; i++) out[i] /= sum;
	return { probs: out, title: t };
}

/** Indexes of the k largest values, largest first. */
function topK(values, k) {
	const idx = [];
	for (let i = 0; i < values.length; i++) {
		if (idx.length < k) { idx.push(i); idx.sort((a, b) => values[b] - values[a]); continue; }
		if (values[i] > values[idx[k - 1]]) { idx[k - 1] = i; idx.sort((a, b) => values[b] - values[a]); }
	}
	return idx;
}

/**
 * Pick the confidence above which suggestions are right at least `target` of the time, from
 * held-back examples [{conf, top1: bool, top3: bool}]. Returns the numbers shown on the Overview.
 */
function calibrate(examples, target = 0.9, fallback = 0.5) {
	const n = examples.length;
	if (!n) return { threshold: fallback, n: 0, top1: 0, top3: 0, sureShare: 0, sureAccuracy: 0, calibrated: false };
	const top1 = examples.filter((e) => e.top1).length / n;
	const top3 = examples.filter((e) => e.top3).length / n;
	const sorted = [...examples].sort((a, b) => b.conf - a.conf);
	let hits = 0;
	let bestK = 0;
	for (let k = 1; k <= n; k++) {
		hits += sorted[k - 1].top1 ? 1 : 0;
		// keep the largest share that still meets the target (ties in confidence stay together)
		if (hits / k >= target && (k === n || sorted[k].conf < sorted[k - 1].conf)) bestK = k;
	}
	const calibrated = n >= 60;
	if (!bestK || !calibrated) {
		return { threshold: calibrated ? 1.01 : fallback, n, top1, top3, sureShare: 0, sureAccuracy: 0, calibrated };
	}
	const threshold = sorted[bestK - 1].conf;
	const sure = sorted.slice(0, bestK);
	return {
		threshold, n, top1, top3,
		sureShare: bestK / n,
		sureAccuracy: sure.filter((e) => e.top1).length / bestK,
		calibrated,
	};
}

module.exports = { withTitle, topK, calibrate };
