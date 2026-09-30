'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { core, rng } = require('../lib/helpers');

const names = core('core/names.js');
const ridge = core('core/ridge.js');
const suggest = core('core/suggest.js');
const moves = core('core/moves.js');
const scope = core('core/scope.js');
const quant = core('core/quant.js');
const settings = core('core/settings.js');

// ── names ──
test('folder base names', () => {
	assert.strictEqual(names.folderBase('Tifa Lockhart - FF'), 'tifa lockhart');
	assert.strictEqual(names.folderBase('Mai -  DOA'), 'mai');
	assert.strictEqual(names.folderBase('.Others - Final Fantasy - FF'), '');
	assert.strictEqual(names.folderBase('_EMPTY - delete me'), '');
	assert.strictEqual(names.folderBase('D.Va'), 'd.va');
	assert.strictEqual(names.folderBase("Y'shtola Rhul - FF"), "y'shtola rhul");
	assert.strictEqual(names.folderBase('Apex Legends™'), 'apex legends');
});

test('title matching: whole words, longest name wins, ties returned', () => {
	const bases = new Map([['a', 'tifa'], ['b', 'tifa lockhart'], ['c', 'kyrie'], ['d', 'kyrie canaan'], ['e', 'raven'], ['f', 'raven'], ['g', 'd.va'], ['h', '2b']]);
	assert.deepStrictEqual(names.titleMatches('Tifa Lockhart in the bar', bases), ['b']);
	assert.deepStrictEqual(names.titleMatches('tifa_pool_party', bases), ['a']);
	assert.deepStrictEqual(names.titleMatches('Tifany dance', bases), []);
	assert.deepStrictEqual(names.titleMatches('KYRIE CANAAN 4K', bases), ['d']);
	assert.deepStrictEqual(names.titleMatches('Raven night', bases).sort(), ['e', 'f']);
	assert.deepStrictEqual(names.titleMatches('D.Va (Overwatch)', bases), ['g']);
	assert.deepStrictEqual(names.titleMatches('2B - Nier', bases), ['h']);
	assert.deepStrictEqual(names.titleMatches('', bases), []);
});

// ── ridge ──
function randomProblem(seed, n, d, C) {
	const r = rng(seed);
	const X = [];
	const y = [];
	for (let i = 0; i < n; i++) {
		const c = r.int(0, C);
		const x = new Float64Array(d);
		for (let k = 0; k < d - 1; k++) x[k] = r.next() - 0.5 + (k % C === c ? 0.8 : 0);
		x[d - 1] = 1;
		X.push(x); y.push(c);
	}
	return { X, y };
}
function normalEquations(X, y, w, d, C) {
	const G = new Float64Array(d * d);
	const R = new Float64Array(C * d);
	X.forEach((x, i) => {
		for (let a = 0; a < d; a++) { for (let b = 0; b < d; b++) G[a * d + b] += w[i] * x[a] * x[b]; R[y[i] * d + a] += w[i] * x[a]; }
	});
	return { G, R };
}

test('cholesky solve inverts a symmetric positive definite system', () => {
	const d = 6;
	const r = rng(3);
	const M = new Float64Array(d * d);
	for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) M[i * d + j] = r.next();
	const A = new Float64Array(d * d);   // A = M M' + I
	for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) { let s = i === j ? 1 : 0; for (let k = 0; k < d; k++) s += M[i * d + k] * M[j * d + k]; A[i * d + j] = s; }
	const b = Float64Array.from({ length: d }, () => r.next());
	const L = ridge.cholesky(Float64Array.from(A), d);
	const x = ridge.cholSolve(L, Float64Array.from(b), d);
	for (let i = 0; i < d; i++) { let s = 0; for (let k = 0; k < d; k++) s += A[i * d + k] * x[k]; assert.ok(Math.abs(s - b[i]) < 1e-9); }
	assert.throws(() => ridge.cholesky(new Float64Array([1, 2, 2, 1]), 2));
});

test('ridge solve satisfies (G + lam I) W = R and scores separate classes', () => {
	const d = 9, C = 4;
	const { X, y } = randomProblem(11, 120, d, C);
	const w = y.map(() => 1);
	const { G, R } = normalEquations(X, y, w, d, C);
	const { W, lam } = ridge.solve(G, R, C, 0.003, d);
	for (let c = 0; c < C; c++) for (let i = 0; i < d; i++) {
		let s = lam * W[c * d + i];
		for (let k = 0; k < d; k++) s += G[i * d + k] * W[c * d + k];
		assert.ok(Math.abs(s - R[c * d + i]) < 1e-4, `row ${i} class ${c}`);
	}
	let right = 0;
	X.forEach((x, i) => { const s = ridge.scores(W, C, x.subarray(0, d - 1), d); if (s.indexOf(Math.max(...s)) === y[i]) right++; });
	assert.ok(right / X.length > 0.8, `train accuracy ${right / X.length}`);
});

test('leave-one-out scores equal a refit without that video', () => {
	const d = 7, C = 3;
	const { X, y } = randomProblem(5, 40, d, C);
	const w = y.map((c) => 1 / Math.sqrt(y.filter((v) => v === c).length));
	const { G, R } = normalEquations(X, y, w, d, C);
	const full = ridge.solve(G, R, C, 0.01, d);
	const i = 13;
	const s = ridge.scores(full.W, C, X[i].subarray(0, d - 1), d);
	const loo = ridge.leaveOneOut(s, full.L, X[i].subarray(0, d - 1), w[i], y[i], d);
	// refit without video i but with the same lambda
	const keep = X.map((_, k) => k).filter((k) => k !== i);
	const ne = normalEquations(keep.map((k) => X[k]), keep.map((k) => y[k]), keep.map((k) => w[k]), d, C);
	const L = Float64Array.from(ne.G);
	for (let k = 0; k < d; k++) L[k * d + k] += full.lam;
	ridge.cholesky(L, d);
	for (let c = 0; c < C; c++) {
		const col = Float64Array.from(ne.R.subarray(c * d, (c + 1) * d));
		ridge.cholSolve(L, col, d);
		let sc = 0;
		for (let k = 0; k < d; k++) sc += col[k] * X[i][k];
		assert.ok(Math.abs(sc - loo[c]) < 1e-6, `class ${c}: ${sc} vs ${loo[c]}`);
	}
});

test('softmax', () => {
	const p = ridge.softmax(new Float64Array([0.1, 0.9, 0.2]), 0.05);
	assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-12);
	assert.strictEqual(p.indexOf(Math.max(...p)), 1);
});

// ── suggest ──
test('title goes first, the model picks among same-length names', () => {
	const p = new Float64Array([0.5, 0.3, 0.15, 0.05]);
	const t = suggest.withTitle(p, [2]);
	assert.strictEqual(t.title, 2);
	assert.strictEqual(suggest.topK(t.probs, 1)[0], 2);
	assert.ok(t.probs[2] > 0.66);
	const tie = suggest.withTitle(p, [3, 1]);
	assert.strictEqual(tie.title, 1);
	assert.strictEqual(suggest.withTitle(p, []).probs, p);
	assert.deepStrictEqual(suggest.topK([0.1, 0.4, 0.2, 0.3], 3), [1, 3, 2]);
});

test('calibration picks the confidence where suggestions are right often enough', () => {
	const ex = [];
	for (let i = 0; i < 200; i++) { const conf = i / 200; ex.push({ conf, top1: conf > 0.5 || i % 3 === 0, top3: true }); }
	const c = suggest.calibrate(ex, 0.9);
	assert.ok(c.calibrated);
	const sure = ex.filter((e) => e.conf >= c.threshold);
	assert.ok(sure.filter((e) => e.top1).length / sure.length >= 0.9);
	assert.ok(c.sureShare > 0.4 && c.sureShare < 0.7, `share ${c.sureShare}`);
	assert.strictEqual(suggest.calibrate(ex.slice(0, 20), 0.9).calibrated, false);
	assert.strictEqual(suggest.calibrate([], 0.9).n, 0);
});

// ── moves ──
const FOLDERS = new Map([
	['OW', { id: 'OW', parent: null, tags: ['Overwatch'] }],
	['MERCY', { id: 'MERCY', parent: 'OW', tags: ['Mercy'] }],
	['DVA', { id: 'DVA', parent: 'OW', tags: ['D.Va'] }],
	['FF', { id: 'FF', parent: null, tags: ['Final Fantasy'] }],
	['TIFA', { id: 'TIFA', parent: 'FF', tags: ['Tifa'] }],
	['NEW', { id: 'NEW', parent: null, tags: [] }],
	['FAV', { id: 'FAV', parent: null, tags: ['Favourite'] }],
]);

test('auto-tag chain walks up the parents', () => {
	assert.deepStrictEqual(moves.chainTags('MERCY', FOLDERS), ['Mercy', 'Overwatch']);
	assert.deepStrictEqual(moves.chainTags('NEW', FOLDERS), []);
	assert.deepStrictEqual(moves.chainTags('missing', FOLDERS), []);
});

test('a move swaps auto-tags and keeps the user\'s own tags', () => {
	const p = moves.planMove({ folders: ['MERCY'], tags: ['Mercy', 'Overwatch', 'my tag'] }, 'TIFA', FOLDERS);
	assert.deepStrictEqual(p.folders, ['TIFA']);
	assert.deepStrictEqual(p.tags, ['my tag', 'Tifa', 'Final Fantasy']);
	assert.deepStrictEqual(p.removedTags, ['Mercy', 'Overwatch']);
	// within the same franchise the shared parent tag stays
	const q = moves.planMove({ folders: ['MERCY'], tags: ['Mercy', 'Overwatch'] }, 'DVA', FOLDERS);
	assert.deepStrictEqual(q.tags, ['Overwatch', 'D.Va']);
	// from a folder without auto-tags
	const r = moves.planMove({ folders: ['NEW'], tags: [] }, 'DVA', FOLDERS);
	assert.deepStrictEqual(r.tags, ['D.Va', 'Overwatch']);
	// tags off
	const s = moves.planMove({ folders: ['MERCY'], tags: ['Mercy'] }, 'TIFA', FOLDERS, { swapTags: false });
	assert.deepStrictEqual(s.tags, ['Mercy']);
});

test('keeping folders outside the learned set', () => {
	const p = moves.planMove({ folders: ['FAV', 'MERCY'], tags: ['Favourite', 'Mercy', 'Overwatch'] }, 'TIFA', FOLDERS,
		{ replaceFolders: false, keepFolder: (f) => f === 'FAV' });
	assert.deepStrictEqual(p.folders, ['FAV', 'TIFA']);
	assert.deepStrictEqual(p.tags, ['Favourite', 'Tifa', 'Final Fantasy']);
	const all = moves.planMove({ folders: ['FAV', 'MERCY'], tags: ['Favourite'] }, 'TIFA', FOLDERS);
	assert.deepStrictEqual(all.folders, ['TIFA']);
	assert.ok(moves.sameSet(['a', 'b'], ['b', 'a']));
	assert.ok(!moves.sameSet(['a'], ['a', 'b']));
});

// ── scope ──
function tree() {
	const f = new Map();
	const add = (id, parent) => f.set(id, { id, parent, children: [] });
	add('A', null); add('A1', 'A'); add('A2', 'A'); add('A2x', 'A2'); add('B', null);
	for (const n of f.values()) if (n.parent) f.get(n.parent).children.push(n.id);
	return f;
}

test('learn scope: choices inherit down the tree', () => {
	const f = tree();
	assert.ok(scope.isLearned('A2x', f, {}));
	assert.ok(!scope.isLearned('A2x', f, { A: false }));
	assert.ok(scope.isLearned('A2x', f, { A: false, A2: true }));
	const set = scope.learnedSet(f, { A: false, A2: true });
	assert.deepStrictEqual([...set].sort(), ['A2', 'A2x', 'B']);
	assert.strictEqual(scope.treeState('A', f, set), 'mixed');
	assert.strictEqual(scope.treeState('B', f, set), 'on');
	assert.strictEqual(scope.treeState('A1', f, set), 'off');
});

test('learn scope: clicking a folder covers its subfolders', () => {
	const f = tree();
	let c = scope.toggle('A', f, { A2: false }, false);
	assert.deepStrictEqual(c, { A: false });
	c = scope.toggle('A2', f, c, true);
	assert.deepStrictEqual(c, { A: false, A2: true });
	c = scope.toggle('A', f, c, true);
	assert.deepStrictEqual(c, {});
});

// ── quant, settings ──
test('int8 fingerprints stay within 0.0001 cosine', () => {
	const r = rng(9);
	const v = new Float32Array(1024);
	let n = 0;
	for (let i = 0; i < 1024; i++) { v[i] = r.next() - 0.5; n += v[i] * v[i]; }
	for (let i = 0; i < 1024; i++) v[i] /= Math.sqrt(n);
	const { q, scale } = quant.quantize(v);
	const back = quant.dequantize(q, scale);
	let dot = 0, nb = 0;
	for (let i = 0; i < 1024; i++) { dot += v[i] * back[i]; nb += back[i] * back[i]; }
	assert.ok(dot / Math.sqrt(nb) > 0.9999);
});

test('settings are clamped and learn choices are per library', () => {
	const s = settings.normalize({ minVideosPerFolder: 999, sureTargetPercent: '85', suggestionCount: 0, useGpu: 0, sortSource: 'weird', libraries: { lib1: { learn: { A: 1, B: 0 } } } });
	assert.strictEqual(s.minVideosPerFolder, 50);
	assert.strictEqual(s.sureTargetPercent, 85);
	assert.strictEqual(s.suggestionCount, 1);
	assert.strictEqual(s.useGpu, false);
	assert.strictEqual(s.sortSource, 'unsorted');
	assert.deepStrictEqual(settings.learnChoices(s, 'lib1'), { A: true, B: false });
	assert.deepStrictEqual(settings.learnChoices(s, 'other'), {});
	const patch = settings.withLearnChoice(s, 'lib1', 'A', null);
	assert.deepStrictEqual(patch.libraries.lib1.learn, { B: false });
});
