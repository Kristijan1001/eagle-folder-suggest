'use strict';
// Development harness: runs the plugin pages in Electron 22 (Eagle 4's runtime) with a stand-in `eagle`
// API (mock-eagle.js) over the synthetic fixture library (tools/make_fixtures.py). Its data folder is a
// temporary one, so it never touches the real plugin's settings, fingerprints or engine port.
//
//   npx electron@22 tools/ui-harness/main.js [--port=47612] [--inspector=<itemId>]
//
// Control endpoint (127.0.0.1 only; ?win=main|inspector, default main):
//   POST /eval   body = JS statements (use `return`), JSON result
//   GET  /shot?file=out.png      GET /console      GET /reload      GET /size?w=&h=      GET /quit
//   GET  /inspector?id=<itemId>  (re)open the Inspector page for an item

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const root = path.resolve(__dirname, '..', '..');
const pluginDir = path.join(root, 'plugin');
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1];
const port = Number(arg('port')) || 47612;

// private data folder (settings, fingerprints, engine.json) with the model linked in
const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-harness-'));
process.env.LOCALAPPDATA = appData;
fs.mkdirSync(path.join(appData, 'Folder Suggest', 'models'), { recursive: true });
const model = path.join(root, 'models', 'pixai-v0.9-fingerprint-fp16.onnx');
if (fs.existsSync(model)) fs.linkSync(model, path.join(appData, 'Folder Suggest', 'models', path.basename(model)));
// the fixture library's Inbox is a staging folder: not learned from (like a real setup)
fs.writeFileSync(path.join(appData, 'Folder Suggest', 'settings.json'), JSON.stringify({ libraries: { [require(path.join(pluginDir, 'js', 'core', 'paths.js')).libraryKey(path.join(root, 'test', 'fixtures', 'library'))]: { learn: { F_INBOX: false, F_FAV: false } } } }));

const consoleLog = { main: [], inspector: [] };
const wins = {};
let quitting = false;

function makeWindow(kind, url, opts) {
	const w = new BrowserWindow({
		...opts, show: true, backgroundColor: kind === 'main' ? '#2a2b2f' : '#303134',
		webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: false, sandbox: false, backgroundThrottling: false, preload: path.join(__dirname, 'mock-eagle.js') },
	});
	w.webContents.on('console-message', (_e, level, message, line, source) => {
		consoleLog[kind].push({ level: ['verbose', 'info', 'warning', 'error'][level] || level, message, source: `${path.basename(source || '')}:${line}` });
		if (consoleLog[kind].length > 2000) consoleLog[kind].shift();
	});
	w.webContents.on('render-process-gone', (_e, d) => consoleLog[kind].push({ level: 'error', message: `renderer gone: ${d.reason}` }));
	w.loadURL(url);
	wins[kind] = w;
	return w;
}

function openInspector(id) {
	const url = `${require('url').pathToFileURL(path.join(pluginDir, 'inspector.html')).href}?id=${encodeURIComponent(id)}&path=&width=711&height=400&lang=en&theme=GRAY`;
	if (wins.inspector && !wins.inspector.isDestroyed()) { wins.inspector.loadURL(url); return; }
	makeWindow('inspector', url, { width: 300, height: 260, x: 40, y: 60, frame: true, title: 'Inspector panel' });
}

app.whenReady().then(() => {
	const main = makeWindow('main', `${require('url').pathToFileURL(path.join(pluginDir, 'index.html')).href}?theme=GRAY&locale=en`, { width: 1240, height: 820, frame: false });
	main.on('close', (e) => { if (quitting) return; e.preventDefault(); main.hide(); });
	main.on('hide', () => main.webContents.send('plugin-hide'));
	main.on('show', () => main.webContents.send('plugin-show'));
	if (arg('inspector')) setTimeout(() => openInspector(arg('inspector')), 4000);

	ipcMain.handle('harness.window', (e, method, a, b) => {
		const w = BrowserWindow.fromWebContents(e.sender);
		switch (method) {
			case 'minimize': w.minimize(); return true;
			case 'maximize': w.maximize(); return true;
			case 'unmaximize': w.unmaximize(); return true;
			case 'isMaximized': return w.isMaximized();
			case 'hide': w.hide(); return true;
			case 'show': w.show(); return true;
			default: return null;
		}
	});
	ipcMain.handle('harness.dialog', async (_e, method, options) => {
		if (method === 'showOpenDialog') return dialog.showOpenDialog(options);
		return null;
	});

	http.createServer((req, res) => {
		const url = new URL(req.url, `http://127.0.0.1:${port}`);
		const kind = url.searchParams.get('win') || 'main';
		const w = wins[kind];
		const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
		if (url.pathname === '/inspector') { openInspector(url.searchParams.get('id')); send(200, { ok: true }); return; }
		if (url.pathname === '/quit') { quitting = true; send(200, { ok: true }); setTimeout(() => { try { fs.rmSync(appData, { recursive: true, force: true }); } catch { /* engine may hold files */ } app.exit(0); }, 300); return; }
		if (!w || w.isDestroyed()) { send(404, { ok: false, error: `no ${kind} window` }); return; }
		if (url.pathname === '/eval') {
			let body = '';
			req.on('data', (d) => { body += d; });
			req.on('end', async () => {
				try {
					const wrapped = `(async () => { ${body} })().then((r) => { try { return JSON.parse(JSON.stringify(r === undefined ? null : r)); } catch (e) { return String(r); } })`;
					send(200, { ok: true, result: await w.webContents.executeJavaScript(wrapped, true) });
				}
				catch (err) { send(200, { ok: false, error: String(err && err.stack || err) }); }
			});
			return;
		}
		if (url.pathname === '/shot') {
			w.webContents.capturePage().then((img) => { fs.writeFileSync(url.searchParams.get('file'), img.toPNG()); send(200, { ok: true }); })
				.catch((err) => send(500, { ok: false, error: String(err) }));
			return;
		}
		if (url.pathname === '/console') { send(200, { ok: true, log: consoleLog[kind].splice(0) }); return; }
		if (url.pathname === '/reload') { w.webContents.reloadIgnoringCache(); send(200, { ok: true }); return; }
		if (url.pathname === '/size') { w.setSize(Number(url.searchParams.get('w')), Number(url.searchParams.get('h'))); send(200, { ok: true }); return; }
		send(404, { ok: false });
	}).listen(port, '127.0.0.1');
});

app.on('window-all-closed', () => {});
