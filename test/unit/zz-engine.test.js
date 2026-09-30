'use strict';
// End-to-end: the real engine process (Eagle's runtime) on a small throwaway library made from the
// model-test thumbnails (data/, not shipped). Skips when that data or the model is not there.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { fork } = require('child_process');
const { PLUGIN } = require('../lib/helpers');

const ROOT = path.resolve(PLUGIN, '..');
const DATA = path.join(ROOT, 'data');
const MODEL = path.join(ROOT, 'models', 'pixai-v0.9-fingerprint-fp16.onnx');
const ready = fs.existsSync(path.join(DATA, 'dataset.json')) && fs.existsSync(MODEL);

function engine(appData) {
	const child = fork(path.join(PLUGIN, 'js', 'engine', 'main.js'), [], { execPath: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LOCALAPPDATA: appData }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
	let id = 1;
	const pending = new Map();
	const logs = [];
	child.on('message', (m) => {
		if (m.event) { if (m.event === 'log') logs.push(m.data); return; }
		const p = pending.get(m.id); pending.delete(m.id);
		if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error));
	});
	const call = (cmd, args) => new Promise((resolve, reject) => { const n = id++; pending.set(n, { resolve, reject }); child.send({ id: n, cmd, args }); });
	return { child, call, logs };
}

function httpCall(conn, method, route, body, token = conn.token) {
	return new Promise((resolve, reject) => {
		const data = body ? JSON.stringify(body) : null;
		const r = http.request({ host: '127.0.0.1', port: conn.port, method, path: route, agent: false, headers: { 'x-token': token, ...(data ? { 'Content-Type': 'application/json' } : {}) } }, (res) => {
			let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ code: res.statusCode, body: JSON.parse(b) }));
		});
		r.on('error', reject);
		if (data) r.write(data);
		r.end();
	});
}

test('engine: fingerprint, learn, suggest, move, undo', { skip: !ready && 'model-test data or model not present', timeout: 300000 }, async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-e2e-'));
	const appData = path.join(tmp, 'appdata');
	const lib = path.join(tmp, 'E2E.library');
	fs.mkdirSync(path.join(appData, 'Folder Suggest', 'models'), { recursive: true });
	fs.linkSync(MODEL, path.join(appData, 'Folder Suggest', 'models', path.basename(MODEL)));
	const ds = JSON.parse(fs.readFileSync(path.join(DATA, 'dataset.json'), 'utf8'));
	const pick = [...new Set(ds.items.map((i) => i.folder))].slice(40, 52);
	const items = ds.items.filter((i) => pick.includes(i.folder));
	const folders = pick.map((f, i) => ({ id: f, name: ds.items.find((x) => x.folder === f).path.split('/').pop(), parent: 'ROOT', tags: [`T${i}`] }));
	folders.push({ id: 'ROOT', name: 'Chars', parent: null, tags: ['Chars'] }, { id: 'INBOX', name: 'Inbox', parent: null, tags: [] });
	const truth = new Map();
	const engItems = items.map((it) => {
		const name = it.name.replace(/[\\/:*?"<>|]/g, '_');
		const dir = path.join(lib, 'images', `${it.id}.info`);
		fs.mkdirSync(dir, { recursive: true });
		fs.linkSync(path.join(DATA, it.thumb), path.join(dir, `${name}_thumbnail.png`));
		const test = it.split === 'test';
		if (test) truth.set(it.id, it.folder);
		return { id: it.id, name, ext: 'mp4', folders: test ? ['INBOX'] : [it.folder], tags: [] };
	});
	engItems.push({ id: 'IMAGE0000001', name: 'a picture', ext: 'jpg', folders: [], tags: [] });

	const e = engine(appData);
	try {
		const settings = { libraries: {} };
		const init = await e.call('init', { libraryPath: lib, pluginRoot: PLUGIN, settings });
		assert.ok(init.modelAvailable);
		// Inbox is where new videos arrive: do not learn from it
		const key = require(path.join(PLUGIN, 'js', 'core', 'paths.js')).libraryKey(lib);
		settings.libraries[key] = { learn: { INBOX: false } };
		await e.call('data', { items: engItems, folders });
		await e.call('settings', { settings });
		for (let i = 0; i < 240; i++) {
			const st = await e.call('status');
			if (!st.index.pending && !st.index.active && st.stored >= engItems.length - 1) break;
			await new Promise((r) => setTimeout(r, 1000));
		}
		const st = await e.call('train');
		assert.strictEqual(st.learnedFolders, folders.length - 1);
		assert.ok(st.learning && st.learning.classes === pick.length, `classes ${st.learning && st.learning.classes}`);
		assert.strictEqual(st.unsorted, truth.size);

		// the Sort view's queue = the held-back videos (in Inbox)
		const queue = await e.call('queue', { source: 'unsorted' });
		assert.deepStrictEqual(new Set(queue), new Set(truth.keys()));

		const res = await e.call('suggestMany', { ids: queue, k: 3 });
		let right = 0;
		for (const id of queue) if (res[id].suggestions[0].folderId === truth.get(id)) right++;
		assert.ok(right / queue.length >= 0.6, `first pick right ${right}/${queue.length}`);

		// the Inspector's HTTP side
		const conn = JSON.parse(fs.readFileSync(path.join(appData, 'Folder Suggest', 'engine.json'), 'utf8'));
		assert.strictEqual((await httpCall(conn, 'GET', `/suggest?id=${queue[0]}`, null, 'wrong')).code, 403);
		const one = (await httpCall(conn, 'GET', `/suggest?id=${queue[0]}&folders=INBOX`)).body.result;
		assert.strictEqual(one.status, 'ready');
		assert.strictEqual(one.suggestions.length, 3);
		assert.strictEqual((await httpCall(conn, 'GET', '/suggest?id=IMAGE0000001')).body.result.status, 'not-video');

		// plan + moved + last move + undone (what the Inspector does around item.save())
		const target = one.suggestions[0].folderId;
		const before = { folders: ['INBOX'], tags: ['keep me'] };
		const plan = (await httpCall(conn, 'POST', '/plan', { item: { id: queue[0], ...before }, target })).body.result;
		assert.deepStrictEqual(plan.folders, [target]);
		assert.ok(plan.tags.includes('keep me') && plan.tags.includes('Chars'));
		await httpCall(conn, 'POST', '/moved', { id: queue[0], name: 'x', before, after: { folders: plan.folders, tags: plan.tags }, target });
		const last = (await httpCall(conn, 'GET', '/last-move')).body.result;
		assert.strictEqual(last.id, queue[0]);
		assert.strictEqual(last.entries.length, 1);
		assert.strictEqual((await e.call('status')).unsorted, truth.size - 1);
		// a moved (now sorted) video is judged without itself only after relearning; before that it is simply scored
		await httpCall(conn, 'POST', '/undone', { ids: [queue[0]] });
		assert.strictEqual((await httpCall(conn, 'GET', '/last-move')).body.result, null);
		assert.strictEqual((await e.call('status')).unsorted, truth.size);

		// a batch of moves is undone as one
		for (const id of queue.slice(1, 4)) await e.call('moved', { id, before: { folders: ['INBOX'], tags: [] }, after: { folders: [target], tags: [] }, target, batch: 'b1' });
		const lb = await e.call('lastMove');
		assert.strictEqual(lb.count, 3);
		await e.call('undone', { batch: 'b1' });
		assert.strictEqual(await e.call('lastMove'), null);

		// a sorted video gets leave-one-out suggestions
		const sortedId = engItems.find((i) => !truth.has(i.id) && i.ext === 'mp4').id;
		const s2 = await e.call('suggest', { id: sortedId });
		assert.ok(s2.loo);

		// review: misfile six sorted videos into another folder, relearn, and they should be listed
		const byFolder = new Map();
		for (const it of engItems) if (it.ext === 'mp4' && !truth.has(it.id)) { if (!byFolder.has(it.folders[0])) byFolder.set(it.folders[0], []); byFolder.get(it.folders[0]).push(it); }
		const [fa, fb] = [...byFolder.keys()];
		const misfiled = byFolder.get(fa).slice(0, 6).map((it) => ({ ...it, folders: [fb] }));
		await e.call('itemsChanged', { upsert: misfiled });
		await e.call('train');
		const rv = await e.call('review');
		assert.strictEqual(rv.status, 'ready');
		const caught = misfiled.filter((it) => rv.ids.includes(it.id)).length;
		assert.ok(caught >= 4, `review caught ${caught} of 6 misfiled videos`);
		assert.ok(rv.ids.length < rv.checked * 0.25, `review flagged ${rv.ids.length} of ${rv.checked}`);
		const flaggedOne = misfiled.find((it) => rv.ids.includes(it.id));
		const back = await e.call('suggest', { id: flaggedOne.id });
		assert.strictEqual(back.suggestions[0].folderId, fa, 'a flagged misfiled video is suggested back to its real folder');
		assert.ok(back.loo);
		// "keep it where it is" takes it off the list
		await e.call('keep', { id: rv.ids[0] });
		const rv2 = await e.call('review');
		assert.ok(!rv2.ids.includes(rv.ids[0]));

		// the model file going away is reported, not crashed on
		await e.call('settings', { settings: { ...settings, modelPath: path.join(tmp, 'nope.onnx') } });
		const st2 = await e.call('status');
		assert.strictEqual(st2.model.available, false);
	}
	finally {
		try { await e.call('shutdown'); } catch { /* exiting */ }
		await new Promise((r) => setTimeout(r, 300));
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
