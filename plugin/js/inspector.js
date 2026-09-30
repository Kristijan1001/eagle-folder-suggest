'use strict';
// The Inspector panel in Eagle's right sidebar. Eagle loads this page again for every selected video
// (inspector.html?id=<item>&theme=...), so it only asks the background engine (the service part of
// the plugin, over 127.0.0.1) for suggestions and does the move itself through Eagle's API.

(function () {
	const path = require('path');
	const fs = require('fs');
	const http = require('http');
	const ROOT = (() => {
		let p = decodeURIComponent(location.pathname);
		p = p.replace(/^\/+(?=[A-Za-z]:)/, '');
		return path.dirname(path.normalize(p));
	})();
	const req = (rel) => require(path.join(ROOT, 'js', rel));
	const { ico } = req('ui/icons.js');
	const paths = req('core/paths.js');
	const { EagleData } = req('ui/eagle-data.js');

	const params = new URLSearchParams(location.search);
	const itemId = params.get('id');
	document.body.dataset.theme = params.get('theme') || 'GRAY';
	const root = document.getElementById('root');
	const pct = (v) => (v > 0 && v < 0.005 ? '<1%' : `${Math.round((v || 0) * 100)}%`);
	const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));

	let conn = null;
	let item = null;
	let result = null;
	let busy = false;

	function readConn() {
		try { return JSON.parse(fs.readFileSync(paths.engineFile(), 'utf8')); } catch { return null; }
	}

	function request(method, route, body, timeout = 60000) {
		return new Promise((resolve, reject) => {
			const data = body ? JSON.stringify(body) : null;
			const r = http.request({ host: '127.0.0.1', port: conn.port, method, path: route, agent: false, timeout,
				headers: { 'x-token': conn.token, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
				let b = '';
				res.setEncoding('utf8');
				res.on('data', (d) => { b += d; });
				res.on('end', () => {
					try {
						const j = JSON.parse(b);
						if (j.ok) resolve(j.result); else reject(new Error(j.error || `HTTP ${res.statusCode}`));
					}
					catch (err) { reject(err); }
				});
			});
			r.on('timeout', () => r.destroy(new Error('The background engine did not answer in time.')));
			r.on('error', reject);
			if (data) r.write(data);
			r.end();
		});
	}

	// EagleData.move/undo talk to "the engine" through call(cmd, args): map those to the HTTP routes.
	const engine = {
		call(cmd, args) {
			if (cmd === 'plan') return request('POST', '/plan', args);
			if (cmd === 'moved') return request('POST', '/moved', { ...args, source: 'inspector' });
			if (cmd === 'undone') return request('POST', '/undone', args);
			return Promise.reject(new Error(`unsupported ${cmd}`));
		},
	};
	const data = new EagleData(() => {});

	function note(kind, iconName, html) {
		return `<div class="note ${kind}">${ico(iconName, 14)}<div>${html}</div></div>`;
	}

	function render() {
		let html = '';
		const r = result;
		if (!conn) {
			html = note('warn', 'warning', 'Folder Suggest is not running. It starts with Eagle; open it from the Plugins menu once.');
		}
		else if (!r) {
			html = note('', 'sparkle', 'Looking…');
		}
		else if (r.error) {
			html = note('bad', 'error', esc(r.error));
		}
		else if (r.status === 'ready') {
			const top = r.suggestions[0];
			if (top && top.current && r.suggestions.length) html += note('good', 'checkCircle', `Looks right: already in <b>${esc(top.name)}</b>`);
			r.suggestions.forEach((s, i) => {
				const cls = ['row', i === 0 && r.sure && !s.current ? 'sure' : '', s.current ? 'current' : '', busy ? 'busy' : ''].filter(Boolean).join(' ');
				html += `<div class="${cls}" tabindex="0" data-i="${i}" title="${s.current ? 'Already in this folder' : `Move to ${esc(s.name)}`}">`
					+ `<span class="k">${i + 1}</span>`
					+ `<div class="n"><div class="fn">${esc(s.name)}${s.title ? '<span class="badge">title</span>' : ''}</div><div class="fp">${esc(s.path || ' ')}</div></div>`
					+ `<span class="pc">${pct(s.prob)}</span><div class="meter" style="width:${Math.round(s.prob * 100)}%"></div></div>`;
			});
		}
		else if (r.status === 'not-video') html = note('', 'info', 'Folder Suggest works on videos.');
		else if (r.status === 'no-model') html = note('warn', 'warning', 'The fingerprint model is missing: open Folder Suggest.');
		else if (r.status === 'learning' || r.status === 'training') html = note('', 'sparkle', 'Still learning your folders…');
		else if (r.status === 'no-fingerprint') html = note('bad', 'error', `No suggestion: ${esc(r.error || 'the thumbnail could not be read')}`);
		else if (r.status === 'moved') html = note('good', 'check', `Moved to <b>${esc(r.name)}</b> <button class="link" data-act="undo">Undo</button>`);
		else if (r.status === 'undone') html = note('', 'undo', 'Move undone.');
		else if (r.status === 'other-library') html = note('', 'info', 'Folder Suggest is busy with another library.');
		else html = note('', 'info', 'No suggestion for this video.');
		if (r && r.last && r.status !== 'moved') {
			html += `<div class="foot">${ico('history', 12)}<span class="t" title="${esc(r.last.name)}">Last: ${esc(r.last.count > 1 ? `${r.last.count} videos` : r.last.name)} → ${esc(r.last.targetInfo.name)}</span><button class="link" data-act="undo">Undo</button></div>`;
		}
		root.innerHTML = html;
	}

	async function load() {
		conn = readConn();
		if (!conn) { render(); return; }
		if (!paths.sameLibrary(conn.library, eagle.library.path)) { result = { status: 'other-library' }; render(); return; }
		render();
		try {
			item = await eagle.item.getById(itemId);
			if (!item) { result = { status: 'none' }; render(); return; }
			const q = new URLSearchParams({ id: item.id, name: item.name, ext: item.ext, folders: (item.folders || []).join(','), noThumbnail: String(!!item.noThumbnail) });
			result = await request('GET', `/suggest?${q}`);
		}
		catch (err) {
			result = err.code === 'ECONNREFUSED' ? null : { error: err.message };
			if (err.code === 'ECONNREFUSED') conn = null;
		}
		await loadLast();
		render();
	}

	async function loadLast() {
		try { const last = await request('GET', '/last-move', null, 5000); if (result) result.last = last; }
		catch { /* ignore */ }
	}

	async function moveTo(i) {
		if (busy || !result || result.status !== 'ready') return;
		const s = result.suggestions[i];
		if (!s || s.current) return;
		busy = true;
		render();
		try {
			await data.move(engine, item.id, s.folderId, { source: 'inspector' });
			result = { status: 'moved', name: s.name };
		}
		catch (err) { result = { error: `Move failed: ${err.message}` }; }
		busy = false;
		render();
	}

	async function undo() {
		if (busy) return;
		busy = true;
		try {
			const last = await request('GET', '/last-move', null, 5000);
			if (last) {
				const r = await data.undo(engine, last.entries);
				result = r.skipped.length ? { error: `${r.skipped.length} video(s) were moved again since; left alone.` } : { status: 'undone' };
			}
		}
		catch (err) { result = { error: `Undo failed: ${err.message}` }; }
		busy = false;
		await loadLast();
		render();
	}

	root.addEventListener('click', (e) => {
		const act = e.target.closest('[data-act]');
		if (act && act.dataset.act === 'undo') { undo(); return; }
		const row = e.target.closest('.row');
		if (row) moveTo(Number(row.dataset.i));
	});
	document.addEventListener('keydown', (e) => {
		if (e.ctrlKey || e.altKey || e.metaKey) { if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) { undo(); e.preventDefault(); } return; }
		if (e.key >= '1' && e.key <= '5') { moveTo(Number(e.key) - 1); e.preventDefault(); }
		else if (e.key === 'Enter') { moveTo(0); e.preventDefault(); }
		else if (e.key === 'z' || e.key === 'Z') { undo(); e.preventDefault(); }
	});

	let started = false;
	const start = () => { if (started) return; started = true; load(); };
	eagle.onPluginCreate(start);
	eagle.onThemeChanged((t) => { document.body.dataset.theme = t; });
})();
