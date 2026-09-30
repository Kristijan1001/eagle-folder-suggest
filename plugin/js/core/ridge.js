'use strict';
// Weighted ridge regression onto one-hot folder labels, solved in closed form:
//     W = (G + lam*I)^-1 R,   G = sum_i w_i x_i x_i',   R[:, c] = sum_{i in c} w_i x_i
// x_i is a video's 1024-d fingerprint with a constant 1 appended (bias), w_i = 1/sqrt(videos in its
// folder) so a folder with 2,000 videos does not drown one with 10. On the model test this matched
// a trained logistic classifier (77.5% vs 78.2% first-pick with the title check).
// G is d x d (d = 1025) whatever the library size, so solving takes about a second in JavaScript.

const D = 1025;

/** In-place Cholesky factorisation of a symmetric positive definite d x d matrix (row-major, Float64Array). Lower triangle = L. */
function cholesky(A, d = D) {
	for (let j = 0; j < d; j++) {
		const rj = j * d;
		let s = A[rj + j];
		for (let k = 0; k < j; k++) s -= A[rj + k] * A[rj + k];
		if (!(s > 0)) throw new Error('matrix is not positive definite');
		const ljj = Math.sqrt(s);
		A[rj + j] = ljj;
		const inv = 1 / ljj;
		for (let i = j + 1; i < d; i++) {
			const ri = i * d;
			let t = A[ri + j];
			for (let k = 0; k < j; k++) t -= A[ri + k] * A[rj + k];
			A[ri + j] = t * inv;
		}
	}
	for (let i = 0; i < d; i++) for (let j = i + 1; j < d; j++) A[i * d + j] = 0;
	return A;
}

/** Solve L L' x = b in place (b: Float64Array(d)). */
function cholSolve(L, b, d = D) {
	for (let i = 0; i < d; i++) {                 // L y = b
		const ri = i * d;
		let s = b[i];
		for (let k = 0; k < i; k++) s -= L[ri + k] * b[k];
		b[i] = s / L[ri + i];
	}
	for (let i = d - 1; i >= 0; i--) {            // L' x = y
		let s = b[i];
		for (let k = i + 1; k < d; k++) s -= L[k * d + i] * b[k];
		b[i] = s / L[i * d + i];
	}
	return b;
}

/**
 * Solve for all classes. G: Float64Array(d*d) (not modified), R: Float64Array(C*d) with class c at
 * [c*d, (c+1)*d). Returns { W: Float32Array(C*d) same layout, L (Cholesky factor of G + lam*I), lam }.
 */
function solve(G, R, C, lamRel, d = D) {
	let trace = 0;
	for (let i = 0; i < d; i++) trace += G[i * d + i];
	const lam = lamRel * (trace / d || 1);
	const L = Float64Array.from(G);
	for (let i = 0; i < d; i++) L[i * d + i] += lam;
	cholesky(L, d);
	const W = new Float32Array(C * d);
	const b = new Float64Array(d);
	for (let c = 0; c < C; c++) {
		for (let i = 0; i < d; i++) b[i] = R[c * d + i];
		cholSolve(L, b, d);
		for (let i = 0; i < d; i++) W[c * d + i] = b[i];
	}
	return { W, L, lam };
}

/** Scores for one fingerprint (Float32Array(1024), bias appended here). */
function scores(W, C, x, d = D) {
	const out = new Float64Array(C);
	for (let c = 0; c < C; c++) {
		const o = c * d;
		let s = W[o + d - 1];
		for (let i = 0; i < d - 1; i++) s += W[o + i] * x[i];
		out[c] = s;
	}
	return out;
}

/**
 * Leave-one-out scores for a video that is part of the training set with weight w in class c:
 * what the model would say had it not seen this video (exact for ridge: s' = (s - h*y) / (1 - h),
 * h = w * x' (G + lam*I)^-1 x). Lets an already-sorted video be judged by the rest of the library.
 */
function leaveOneOut(s, L, x, w, c, d = D) {
	const z = new Float64Array(d);
	for (let i = 0; i < d - 1; i++) z[i] = x[i];
	z[d - 1] = 1;
	const v = cholSolve(L, Float64Array.from(z), d);
	let h = 0;
	for (let i = 0; i < d; i++) h += z[i] * v[i];
	h *= w;
	if (!(h < 0.999)) return s;
	const out = new Float64Array(s.length);
	for (let k = 0; k < s.length; k++) out[k] = (s[k] - h * (k === c ? 1 : 0)) / (1 - h);
	return out;
}

/** Softmax with temperature (scores are ~0..1 regression outputs; 0.05 matched the test). */
function softmax(s, temp = 0.05) {
	let max = -Infinity;
	for (let i = 0; i < s.length; i++) if (s[i] > max) max = s[i];
	const out = new Float64Array(s.length);
	let sum = 0;
	for (let i = 0; i < s.length; i++) { out[i] = Math.exp((s[i] - max) / temp); sum += out[i]; }
	for (let i = 0; i < s.length; i++) out[i] /= sum;
	return out;
}

module.exports = { D, cholesky, cholSolve, solve, scores, leaveOneOut, softmax };
