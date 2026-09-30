'use strict';
// Background fingerprinting: reads each video's Eagle thumbnail and runs the model on it, in batches
// of 8, loading the next batch from disk while the GPU works on the current one. A video the user
// selects in Eagle jumps the queue (fingerprintNow).

const path = require('path');
const { loadThumbnail } = require('./image');

const BATCH = 8;

function thumbnailPath(libraryPath, it) {
	const dir = path.join(libraryPath, 'images', `${it.id}.info`);
	return it.noThumbnail ? path.join(dir, `${it.name}.${it.ext}`) : path.join(dir, `${it.name}_thumbnail.png`);
}

class Indexer {
	constructor({ store, model, log, onBatch }) {
		this.store = store;
		this.model = model;
		this.log = log || (() => {});
		this.onBatch = onBatch || (() => {});
		this.libraryPath = '';
		this.queue = [];
		this.queued = new Set();
		this.failed = new Map();         // id -> reason (retried after a restart or a re-index)
		this.paused = false;
		this.running = false;
		this.stopped = false;
		this.error = '';
		this.wakeFn = null;
		this.done = 0;
		this.startedAt = 0;
		this.recent = [];                // timestamps of finished items (rate)
		this.current = '';
	}

	/** items in the order they should be fingerprinted; already stored or failed ones are skipped. */
	setQueue(items) {
		this.queue = items.filter((it) => !this.store.has(it.id) && !this.failed.has(it.id));
		this.queued = new Set(this.queue.map((it) => it.id));
		this.done = 0;
		this.startedAt = Date.now();
		this.error = '';
		this.wake();
	}

	add(items, front = false) {
		const fresh = items.filter((it) => !this.store.has(it.id) && !this.failed.has(it.id) && !this.queued.has(it.id));
		for (const it of fresh) this.queued.add(it.id);
		if (front) this.queue.unshift(...fresh); else this.queue.push(...fresh);
		if (fresh.length) this.wake();
	}

	pause() { this.paused = true; }
	resume() { this.paused = false; this.error = ''; this.wake(); }
	stop() { this.stopped = true; this.wake(); }

	wake() { if (this.wakeFn) { const f = this.wakeFn; this.wakeFn = null; f(); } }
	sleep() { return new Promise((r) => { this.wakeFn = r; }); }

	async loadBatch(items) {
		return Promise.all(items.map(async (it) => {
			try { return { it, img: await loadThumbnail(thumbnailPath(this.libraryPath, it)) }; }
			catch (err) { return { it, err: err.code === 'ENOENT' ? 'no thumbnail file' : String(err.message || err) }; }
		}));
	}

	/** Put a prefetched (not yet fingerprinted) batch back at the front of the queue. */
	async requeue(pending) {
		const loaded = await pending;
		const back = loaded.filter((l) => !this.store.has(l.it.id)).map((l) => l.it);
		this.queue.unshift(...back);
		for (const it of back) this.queued.add(it.id);
	}

	takeBatch() {
		const out = [];
		while (this.queue.length && out.length < BATCH) {
			const it = this.queue.shift();
			this.queued.delete(it.id);
			if (!this.store.has(it.id) && !this.failed.has(it.id)) out.push(it);
		}
		return out;
	}

	async run() {
		if (this.running) return;
		this.running = true;
		try {
			let next = null;
			while (!this.stopped) {
				if (this.paused || this.error || (!this.queue.length && !next)) {
					if (next) { await this.requeue(next); next = null; }
					this.current = '';
					await this.sleep();
					continue;
				}
				const loaded = await (next || this.loadBatch(this.takeBatch()));
				next = this.queue.length && !this.paused ? this.loadBatch(this.takeBatch()) : null;
				const ok = loaded.filter((l) => l.img);
				for (const l of loaded) if (l.err) this.failed.set(l.it.id, l.err);
				if (!ok.length) continue;
				this.current = ok[ok.length - 1].it.name;
				let vecs;
				try { vecs = await this.model.embed(ok.map((l) => l.img)); }
				catch (err) {
					this.error = String(err.message || err).split('\n')[0];
					this.log('error', `Fingerprinting stopped: ${this.error}`);
					// put the batch (and the prefetched one) back for when the problem is fixed
					if (next) { await this.requeue(next); next = null; }
					this.queue.unshift(...ok.map((l) => l.it));
					for (const l of ok) this.queued.add(l.it.id);
					continue;
				}
				const ids = [];
				ok.forEach((l, i) => { this.store.put(l.it.id, vecs[i]); ids.push(l.it.id); });
				this.done += ids.length;
				const now = Date.now();
				for (let i = 0; i < ids.length; i++) this.recent.push(now);
				while (this.recent.length && now - this.recent[0] > 30000) this.recent.shift();
				this.onBatch(ids);
				await new Promise((r) => setImmediate(r));
			}
		}
		finally { this.running = false; }
	}

	/** Fingerprint one video right away (the one selected in Eagle). Returns Float32Array or throws. */
	async fingerprintNow(it) {
		const img = await loadThumbnail(thumbnailPath(this.libraryPath, it));
		const [vec] = await this.model.embed([img]);
		this.store.put(it.id, vec);
		this.failed.delete(it.id);
		return vec;
	}

	status() {
		const rate = this.recent.length > 1 ? (this.recent.length - 1) / Math.max(1, (this.recent[this.recent.length - 1] - this.recent[0]) / 1000) : 0;
		return {
			pending: this.queue.length, done: this.done, failed: this.failed.size,
			paused: this.paused, active: this.running && !this.paused && !this.error && this.queue.length > 0,
			error: this.error, rate, current: this.current,
		};
	}
}

module.exports = { Indexer, thumbnailPath, BATCH };
