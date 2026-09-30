'use strict';
// Service window bootstrap. Folder Suggest is a background ("service") plugin: Eagle opens this page
// hidden when it starts, so the engine fingerprints and learns while you work; clicking the plugin
// shows the window. Eagle's preload replaces `require` with a resolver rooted in Eagle's own folder,
// so every plugin module is required by absolute path from here.

(function () {
	const path = require('path');
	const ROOT = (() => {
		let p = decodeURIComponent(location.pathname);
		p = p.replace(/^\/+(?=[A-Za-z]:)/, '');
		return path.dirname(path.normalize(p));
	})();
	const req = (rel) => require(path.join(ROOT, 'js', rel));

	const { h, icon, clear, number } = req('ui/dom.js');
	const kit = req('ui/kit.js');
	const { Store } = req('ui/store.js');
	const { EngineClient } = req('ui/engine-client.js');
	const { EagleData } = req('ui/eagle-data.js');
	const paths = req('core/paths.js');

	const app = {
		ROOT, req, kit,
		store: null, engine: null, data: null,
		views: {}, current: null,
		logs: [],
		status: null,
		ready: false,
		listeners: new Map(),
		on(ev, fn) { if (!this.listeners.has(ev)) this.listeners.set(ev, new Set()); this.listeners.get(ev).add(fn); return () => this.listeners.get(ev).delete(fn); },
		emit(ev, data) { for (const fn of this.listeners.get(ev) || []) { try { fn(data); } catch (err) { console.error(err); } } },
		log(level, message) {
			const entry = { t: Date.now(), level, message: String(message) };
			this.logs.push(entry);
			if (this.logs.length > 4000) this.logs.splice(0, 500);
			this.emit('log', entry);
			try { if (level === 'error') eagle.log.error(`Folder Suggest: ${message}`); } catch { /* ignore */ }
		},
		get settings() { return this.store.settings; },
		setSettings(patch) { this.store.set(patch); },
		get libKey() { return paths.libraryKey(eagle.library.path); },
	};
	window.folderSuggest = app;

	function applyTheme(theme) { document.body.dataset.theme = theme || eagle.app.theme || 'GRAY'; }
	function applyScale() { document.body.style.zoom = String((app.settings.uiScalePercent || 100) / 100); }

	// ── shell ──
	const NAV = [
		{ key: 'overview', label: 'Overview', icon: 'overview' },
		{ key: 'sort', label: 'Sort', icon: 'sortIn' },
		{ key: 'settings', label: 'Settings', icon: 'settings' },
		{ key: 'log', label: 'Log', icon: 'log' },
	];
	const navEls = {};
	let sideStatusEl, titleLibEl;

	function buildShell() {
		const root = document.getElementById('app');
		clear(root);
		const maxBtn = h('button', { title: 'Maximize', onclick: async () => {
			if (await eagle.window.isMaximized()) await eagle.window.unmaximize(); else await eagle.window.maximize();
			updateMaxIcon();
		} }, icon('maximize', 14));
		async function updateMaxIcon() {
			try {
				const m = await eagle.window.isMaximized();
				clear(maxBtn).appendChild(icon(m ? 'restore' : 'maximize', 14));
				maxBtn.title = m ? 'Restore' : 'Maximize';
			}
			catch { /* ignore */ }
		}
		app.updateMaxIcon = updateMaxIcon;
		titleLibEl = h('span.lib');
		const titlebar = h('header.titlebar',
			h('img.logo', { src: 'logo.png', alt: '' }),
			h('span.title', 'Folder Suggest'),
			titleLibEl,
			h('span.spacer'),
			h('div.win-btns',
				h('button', { title: 'Minimize', onclick: () => eagle.window.minimize() }, icon('minimize', 14)),
				maxBtn,
				h('button.close', { title: 'Close (keeps working in the background)', onclick: () => eagle.window.hide() }, icon('close', 14))));
		titlebar.addEventListener('dblclick', (e) => { if (e.target === titlebar || e.target.classList.contains('spacer')) maxBtn.click(); });
		const sidebar = h('nav.sidebar');
		for (const n of NAV) {
			const badge = h('span.badge', { style: { display: 'none' } });
			const el = h('div.nav-item', { tabindex: 0, onclick: () => navigate(n.key) }, icon(n.icon, 17), h('span', n.label), badge);
			el.badge = badge;
			navEls[n.key] = el;
			sidebar.appendChild(el);
		}
		sidebar.appendChild(h('div.grow'));
		sideStatusEl = h('div.engine');
		sidebar.appendChild(sideStatusEl);
		const view = h('main#view');
		root.append(titlebar, h('div.body', sidebar, view));
		app.viewRoot = view;
		updateTitle();
		updateSideStatus();
		updateMaxIcon();
	}

	function updateTitle() {
		if (!titleLibEl) return;
		clear(titleLibEl).append(icon('library', 14), app.data ? app.data.libraryName : '');
	}

	function updateSideStatus() {
		if (!sideStatusEl) return;
		const st = app.status;
		clear(sideStatusEl);
		let cls = 'x', text = 'Starting';
		if (st) {
			if (!st.model.available) { cls = 'bad'; text = 'Model file missing'; }
			else if (st.index.error) { cls = 'bad'; text = 'Fingerprinting stopped'; }
			else if (st.index.active) { cls = 'busy'; text = `Fingerprinting ${number(st.stored)} / ${number(st.videos)}`; }
			else if (st.training) { cls = 'busy'; text = 'Learning folders'; }
			else if (st.learning) { cls = 'ok'; text = `${number(st.learning.classes)} folders learned`; }
			else { cls = 'x'; text = 'Waiting for sorted videos'; }
		}
		sideStatusEl.append(h('div.row', h('span.dotmark.' + cls), h('span', text)));
		if (st && st.model.loaded) sideStatusEl.append(h('div', `Model on ${st.model.ep === 'dml' ? 'GPU' : 'CPU'}`));
		const b = navEls.sort && navEls.sort.badge;
		if (b && st) { b.style.display = st.unsorted ? '' : 'none'; b.textContent = number(st.unsorted); }
	}

	function navigate(key, opts) {
		const prev = app.views[app.current];
		if (prev && prev.hide) prev.hide();
		app.current = key;
		for (const [k, el] of Object.entries(navEls)) el.classList.toggle('active', k === key);
		const v = app.views[key];
		clear(app.viewRoot);
		app.viewRoot.appendChild(v.el);
		if (v.show) v.show(opts);
	}
	app.navigate = navigate;

	// ── engine ──
	let restarts = 0;
	async function startEngine() {
		if (!app.engine) {
			app.engine = new EngineClient(ROOT);
			app.engine.on('log', (e) => app.log(e.level, e.message));
			app.engine.on('status', (st) => { app.status = st; updateSideStatus(); app.emit('status', st); });
			app.engine.on('trained', (st) => app.emit('trained', st));
			app.engine.on('moved', (m) => app.emit('moved', m));
			app.engine.on('exit', async () => {
				app.ready = false;
				if (restarts++ > 5) { app.log('error', 'The engine keeps stopping; open the plugin again to retry.'); return; }
				app.log('warn', 'The engine stopped; restarting it.');
				await new Promise((r) => setTimeout(r, 1500 * restarts));
				try { await initEngine(); } catch (err) { app.log('error', `Restart failed: ${err.message}`); }
			});
		}
		await initEngine();
	}

	async function initEngine() {
		app.engine.start();
		const r = await app.engine.init({ libraryPath: eagle.library.path, pluginRoot: ROOT, settings: app.settings });
		app.log('info', `Engine ready (Node ${r.node}); ${number(r.stored)} fingerprints stored for "${app.data.libraryName}".`);
		if (!r.modelAvailable) app.log('warn', `The fingerprint model is not at ${r.modelPath}. Choose it on the Overview page.`);
		await loadLibrary();
		app.ready = true;
		app.emit('ready');
	}

	async function loadLibrary() {
		const t0 = Date.now();
		await app.data.loadFolders();
		const items = await app.data.loadItems();
		app.status = await app.engine.call('data', { items, folders: app.data.folderList() });
		app.log('info', `Library read: ${number(items.length)} items, ${number(app.data.folders.size)} folders (${Date.now() - t0} ms).`);
		updateSideStatus();
		app.emit('status', app.status);
		app.emit('library');
	}
	app.reloadLibrary = loadLibrary;

	// ── keeping up with the library ──
	let polling = false;
	async function poll() {
		if (!app.ready || polling) return;
		polling = true;
		try {
			if (app.data.foldersMaybeChanged()) {
				await app.data.loadFolders();
				app.status = await app.engine.call('foldersChanged', { folders: app.data.folderList() });
				app.emit('library');
			}
			const ch = await app.data.changes();
			if (ch.upsert.length || ch.removed.length) {
				await app.engine.call('itemsChanged', { upsert: ch.upsert, remove: ch.removed });
				app.emit('items', ch);
			}
		}
		catch (err) { app.log('warn', `Checking the library for changes failed: ${err.message}`); }
		finally { polling = false; }
	}
	setInterval(poll, 15000);
	app.poll = poll;

	// ── moves (Sort view) ──
	app.move = async function move(id, target, opts) {
		const rec = await app.data.move(app.engine, id, target, opts);
		app.emit('movedLocal', rec);
		return rec;
	};
	app.undoLast = async function undoLast() {
		const last = await app.engine.call('lastMove');
		if (!last) { kit.toast('Nothing to undo.'); return null; }
		const r = await app.data.undo(app.engine, last.entries);
		if (r.skipped.length) kit.toast(`${r.skipped.length} video(s) had been moved again since and were left alone.`, { kind: 'bad' });
		else kit.toast(r.restored > 1 ? `Undid ${r.restored} moves.` : `Moved "${last.name}" back.`, { kind: 'good' });
		app.emit('undone', last);
		return last;
	};

	// ── keyboard ──
	document.addEventListener('keydown', (e) => {
		if (document.querySelector('.modal-back')) return;
		const v = app.views[app.current];
		if (v && v.onKey && v.onKey(e)) { e.preventDefault(); return; }
		if (e.ctrlKey && !e.shiftKey && e.key >= '1' && e.key <= String(NAV.length)) { navigate(NAV[Number(e.key) - 1].key); e.preventDefault(); }
	});

	// ── lifecycle ──
	async function boot() {
		app.store = new Store();
		eagle.library.path = paths.normalizeLibraryPath(eagle.library.path);
		app.data = new EagleData((l, m) => app.log(l, m));
		applyTheme(eagle.app.theme);
		applyScale();
		app.store.onChange((s, patch) => {
			applyScale();
			if (app.engine && app.ready) app.engine.call('settings', { settings: s }).then((st) => { app.status = st; updateSideStatus(); app.emit('status', st); }).catch(() => {});
			app.emit('settings', patch);
		});
		app.views.overview = req('ui/view-overview.js').create(app);
		app.views.sort = req('ui/view-sort.js').create(app);
		app.views.settings = req('ui/view-settings.js').create(app);
		app.views.log = req('ui/view-log.js').create(app);
		buildShell();
		navigate('overview');
		try { await startEngine(); }
		catch (err) {
			app.log('error', `Engine start failed: ${err.message}`);
			kit.alertDialog('Folder Suggest could not start', `${err.message}\n\nSee the Log page for details.`, 'error');
		}
		updateSideStatus();
	}

	let created = false;
	eagle.onPluginCreate(() => {
		if (created) return;
		created = true;
		boot().catch((err) => {
			console.error(err);
			document.getElementById('app').textContent = `Folder Suggest failed to start: ${err.message}`;
		});
	});
	eagle.onPluginShow(() => {
		if (app.updateMaxIcon) app.updateMaxIcon();
		poll();
		const v = app.views[app.current];
		if (v && v.show) v.show();
	});
	eagle.onThemeChanged((theme) => applyTheme(theme));
	eagle.onLibraryChanged(async () => {
		eagle.library.path = paths.normalizeLibraryPath(eagle.library.path);
		if (!app.store) return;
		app.ready = false;
		updateTitle();
		try { await initEngine(); }
		catch (err) { app.log('error', `Switching library failed: ${err.message}`); }
		updateTitle();
	});
	eagle.onPluginBeforeExit(() => {
		try { if (app.store) app.store.save(); } catch { /* ignore */ }
		try { if (app.engine) app.engine.stop(); } catch { /* ignore */ }
	});
})();
