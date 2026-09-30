'use strict';
// Overview: is everything working, how far fingerprinting is, how good the suggestions are.

const { h, icon, clear, number, span, dateTime } = require('./dom');
const kit = require('./kit');
const paths = require('../core/paths');

const pct = (v) => `${Math.round((v || 0) * 100)}%`;

function create(app) {
	const el = h('div.page');
	let timer = null;

	async function chooseModel() {
		const r = await eagle.dialog.showOpenDialog({ title: 'Choose the fingerprint model', properties: ['openFile'], filters: [{ name: 'ONNX model', extensions: ['onnx'] }] });
		if (!r || r.canceled || !r.filePaths || !r.filePaths[0]) return;
		app.setSettings({ modelPath: r.filePaths[0] });
		kit.toast('Model set. Fingerprinting starts in a moment.', { kind: 'good' });
	}

	async function downloadModel() {
		const ok = await kit.confirmDialog({
			title: 'Download the model?',
			icon: 'download',
			message: 'The model (about 592 MB) is downloaded once from the Folder Suggest project on GitHub and checked against a fixed SHA-256 fingerprint before it is used. It runs entirely on this computer; nothing from your library is ever uploaded.',
			detail: 'It is PixAI Tagger v0.9 (Apache 2.0), converted to ONNX for this plugin. Credits and licences: github.com/Kristijan1001/eagle-folder-suggest',
			okLabel: 'Download',
		});
		if (!ok) return;
		await app.engine.call('downloadModel');
		render();
	}

	function modelCard(st) {
		const m = st.model;
		const ix = st.index;
		const lines = [];
		if (!m.available) {
			const d = m.download;
			const mb = (n) => Math.round((n || 0) / 1048576);
			if (d && !d.error) {
				const frac = d.total ? d.got / d.total : 0;
				return h('div.card',
					h('div.card-head', icon('download', 17), h('h2', 'Downloading the model')),
					h('div.card-body',
						h('div.stat-big', `${mb(d.got)} MB `, h('span.stat-sub', `of ${mb(d.total)} MB`)),
						h('div.bar', h('div', { style: { width: `${(frac * 100).toFixed(1)}%` } })),
						h('div.small.faint', 'Checked against its SHA-256 fingerprint before it is used. Fingerprinting starts right after.'),
						h('div.row', { style: { marginTop: '12px' } }, h('button.btn', { onclick: () => app.engine.call('cancelDownload') }, icon('close', 14), 'Cancel'))));
			}
			return h('div.card',
				h('div.card-head', icon('download', 17), h('h2', 'One-time setup')),
				h('div.card-body',
					h('div', 'Folder Suggest recognises videos with an image model that runs on this computer. It is too big to ship inside the plugin, so it is downloaded once.'),
					h('div.small.faint', { style: { marginTop: '6px' } }, `Or choose the file if you already have it (${paths.MODEL_FILE}).`),
					d && d.error ? h('div.callout.bad', { style: { marginTop: '10px' } }, icon('error', 16), h('div', `Download failed: ${d.error}`)) : null,
					h('div.row.wrap', { style: { marginTop: '12px' } },
						h('button.btn.primary', { onclick: downloadModel }, icon('download', 15), `Download the model (${mb(m.size)} MB)`),
						h('button.btn', { onclick: chooseModel }, icon('folderOpen', 15), 'Choose a file…'))));
		}
		const total = st.videos || 0;
		const done = Math.min(st.stored, total);
		const frac = total ? done / total : 0;
		const left = ix.rate > 0 ? (ix.pending / ix.rate) * 1000 : 0;
		let state;
		if (ix.error) state = h('div.state-line.bad', icon('error', 16), h('span', `Stopped: ${ix.error}`));
		else if (ix.active) state = h('div.state-line.busy', icon('bolt', 16), h('span', `${ix.rate ? `${ix.rate.toFixed(1)} videos/s` : 'Starting'}${left ? ` · about ${span(left)} left` : ''}`));
		else if (ix.paused && ix.pending) state = h('div.state-line', icon('pause', 16), h('span', `Paused with ${number(ix.pending)} to go`));
		else state = h('div.state-line.ok', icon('checkCircle', 16), h('span', ix.pending ? `${number(ix.pending)} waiting` : 'All videos fingerprinted'));
		lines.push(state);
		if (ix.failed) lines.push(h('div.small.faint', `${number(ix.failed)} video(s) have no readable thumbnail and are skipped.`));
		return h('div.card',
			h('div.card-head', icon('film', 17), h('h2', 'Fingerprints'), h('span.spacer'),
				h('span.badge' + (m.loaded ? '.good' : ''), icon('gpu', 12), m.loaded ? (m.ep === 'dml' ? 'On the GPU' : 'On the CPU') : 'Model idle')),
			h('div.card-body',
				h('div.stat-big', `${number(done)} `, h('span.stat-sub', `of ${number(total)} videos`)),
				h('div.bar', h('div', { style: { width: `${(frac * 100).toFixed(1)}%` } })),
				lines,
				h('div.row', { style: { marginTop: '12px' } },
					ix.pending ? (ix.paused || ix.error
						? h('button.btn', { onclick: () => app.engine.call('resume') }, icon('play', 14), ix.error ? 'Try again' : 'Resume')
						: h('button.btn', { onclick: () => app.engine.call('pause') }, icon('pause', 14), 'Pause')) : null,
					h('span.faint.small', 'Fingerprinting reads each video\'s Eagle thumbnail once; new videos are picked up automatically.'))));
	}

	function learnCard(st) {
		const l = st.learning;
		if (!l) {
			return h('div.card', h('div.card-head', icon('sparkle', 17), h('h2', 'Learning')),
				h('div.card-body', h('div.muted', st.training ? 'Learning your folders…'
					: `Folder Suggest learns from videos you have already sorted. It needs at least two folders with ${app.settings.minVideosPerFolder}+ fingerprinted videos.`)));
		}
		return h('div.card',
			h('div.card-head', icon('sparkle', 17), h('h2', 'Learning'), h('span.spacer'),
				st.training ? h('span.badge.accent', 'Relearning…') : h('span.faint.small', `Updated ${dateTime(l.trainedAt)}`)),
			h('div.card-body',
				h('div.stat-big', `${number(l.classes)} `, h('span.stat-sub', `folders learned from ${number(l.examples)} sorted videos`)),
				l.calibrated ? h('div.stat-row',
					h('div.stat-cell', h('div.v', pct(l.top1)), h('div.k', 'first pick right')),
					h('div.stat-cell', h('div.v', pct(l.top3)), h('div.k', 'right folder in top 3')),
					h('div.stat-cell', h('div.v', pct(l.sureShare)), h('div.k', `marked "sure" (right ${pct(l.sureAccuracy)})`)))
					: h('div.small.faint', { style: { marginTop: '8px' } }, 'Accuracy is measured once there are enough sorted videos.'),
				h('div.small.faint', { style: { marginTop: '10px' } }, 'Measured on a tenth of your sorted videos held back while learning. Folders relearn after you move videos.'),
				h('div.row', { style: { marginTop: '12px' } }, h('button.btn', { onclick: async () => { await app.engine.call('train'); } }, icon('refresh', 14), 'Relearn now'))));
	}

	function sortCard(st) {
		return h('div.card',
			h('div.card-head', icon('sortIn', 17), h('h2', 'Waiting to be sorted')),
			h('div.card-body',
				h('div.stat-big', number(st.unsorted), ' ', h('span.stat-sub', 'videos outside your learned folders')),
				h('div.row', { style: { marginTop: '12px' } },
					h('button.btn.primary', { disabled: !st.unsorted || !st.learning, onclick: () => app.navigate('sort', { source: 'unsorted' }) }, icon('sortIn', 15), 'Sort them'))));
	}

	function howCard() {
		return h('div.card',
			h('div.card-head', icon('info', 17), h('h2', 'How to use it')),
			h('div.card-body', h('div.how',
				h('div.n', '1'), h('div', 'Select a video in Eagle. The ', h('b', 'Folder Suggest'), ' panel in the right sidebar shows the folders it belongs in; click one to move it there.'),
				h('div.n', '2'), h('div', 'Or use the ', h('b', 'Sort'), ' page here: one video at a time, ', h('kbd', '1'), ' ', h('kbd', '2'), ' ', h('kbd', '3'), ' move it, ', h('kbd', 'S'), ' skips, ', h('kbd', 'Z'), ' undoes.'),
				h('div.n', '3'), h('div', 'Moves swap the folders\' auto-tags and can always be undone. A green suggestion is "sure".'))));
	}

	async function historyCard() {
		let hist = [];
		try { hist = await app.engine.call('history', { limit: 12 }); } catch { /* engine starting */ }
		const body = h('div.moves');
		if (!hist.length) body.append(h('div.faint', 'No moves yet.'));
		for (const m of hist) {
			body.append(h(`div.move-row${m.undone ? '.undone' : ''}`,
				icon('video', 15),
				h('span.nm', { title: m.name }, m.name),
				h('span.to', icon('folder', 13), m.targetInfo ? m.targetInfo.name : ''),
				h('span.t', dateTime(m.t))));
		}
		const last = hist.find((m) => !m.undone);
		return h('div.card',
			h('div.card-head', icon('history', 17), h('h2', 'Recent moves'), h('span.spacer'),
				last ? h('button.btn.small', { onclick: async () => { await app.undoLast(); render(); } }, icon('undo', 13), 'Undo last') : null),
			h('div.card-body', body));
	}

	async function render() {
		const st = app.status;
		clear(el);
		el.append(h('div.page-head', h('h1', 'Overview'), h('span.sub', app.data ? app.data.libraryName : '')));
		if (!st) { el.append(h('div.muted', 'Starting…')); return; }
		el.append(h('div.ov-grid', modelCard(st), learnCard(st), sortCard(st), howCard()));
		el.append(h('div', { style: { marginTop: '14px' } }, await historyCard()));
	}

	const refresh = () => { if (app.current === 'overview') render(); };
	app.on('status', () => { clearTimeout(timer); timer = setTimeout(refresh, 250); });
	app.on('trained', refresh);
	app.on('moved', refresh);

	return { el, show: render, hide() {} };
}

module.exports = { create };
