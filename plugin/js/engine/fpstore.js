'use strict';
// Fingerprint store: one binary file per library, append-only while running, compacted on load.
//   header  8 bytes  "FSFP0001"
//   record  1056 bytes: id (16 ASCII, zero-padded) | thumbnail mtime (float64) | scale (float32) |
//                       reserved (4) | 1024 int8 values
// The whole store is kept in memory (about 70 MB for 68,000 videos).

const fs = require('fs');
const path = require('path');
const { DIM, quantize, dequantize } = require('../core/quant');

const MAGIC = 'FSFP0001';
const REC = 1056;
const HEAD = 8;

class FingerprintStore {
	constructor(dir) {
		this.dir = dir;
		this.file = path.join(dir, 'fingerprints.bin');
		this.slots = new Map();         // id -> slot
		this.ids = [];
		this.q = new Int8Array(0);      // slots * DIM
		this.scale = new Float32Array(0);
		this.mtime = new Float64Array(0);
		this.capacity = 0;
		this.garbage = 0;
		this.pending = [];              // records waiting to be appended
		this.flushTimer = null;
	}

	get size() { return this.slots.size; }
	has(id) { return this.slots.has(id); }

	grow(min) {
		if (min <= this.capacity) return;
		const cap = Math.max(min, Math.ceil(this.capacity * 1.5), 1024);
		const q = new Int8Array(cap * DIM); q.set(this.q);
		const sc = new Float32Array(cap); sc.set(this.scale);
		const mt = new Float64Array(cap); mt.set(this.mtime);
		this.q = q; this.scale = sc; this.mtime = mt; this.capacity = cap;
	}

	load() {
		fs.mkdirSync(this.dir, { recursive: true });
		if (!fs.existsSync(this.file)) return { loaded: 0 };
		const buf = fs.readFileSync(this.file);
		if (buf.length < HEAD || buf.toString('ascii', 0, HEAD) !== MAGIC) {
			fs.renameSync(this.file, `${this.file}.unreadable-${Date.now()}`);
			return { loaded: 0, reset: true };
		}
		const n = Math.floor((buf.length - HEAD) / REC);
		this.grow(n);
		let records = 0;
		for (let r = 0; r < n; r++) {
			const o = HEAD + r * REC;
			const id = buf.toString('ascii', o, o + 16).replace(/\0+$/, '');
			if (!id) continue;
			records++;
			this.setRaw(id, buf.readDoubleLE(o + 16), buf.readFloatLE(o + 24), new Int8Array(buf.buffer, buf.byteOffset + o + 32, DIM));
		}
		this.garbage = records - this.slots.size;
		if (this.garbage > 0.2 * this.slots.size + 500) this.compact();
		return { loaded: this.slots.size };
	}

	setRaw(id, mtime, scale, q) {
		let slot = this.slots.get(id);
		if (slot === undefined) {
			slot = this.ids.length;
			this.grow(slot + 1);
			this.ids.push(id);
			this.slots.set(id, slot);
		}
		this.q.set(q, slot * DIM);
		this.scale[slot] = scale;
		this.mtime[slot] = mtime;
		return slot;
	}

	/** Store a fingerprint (Float32Array(1024), unit length). */
	put(id, vec, thumbMtime = 0) {
		const { q, scale } = quantize(vec);
		if (this.slots.has(id)) this.garbage++;
		this.setRaw(id, thumbMtime, scale, q);
		const rec = Buffer.alloc(REC);
		rec.write(id.slice(0, 16), 0, 'ascii');
		rec.writeDoubleLE(thumbMtime, 16);
		rec.writeFloatLE(scale, 24);
		Buffer.from(q.buffer, q.byteOffset, DIM).copy(rec, 32);
		this.pending.push(rec);
		if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 2000);
	}

	/** Fingerprint as Float32Array(1024), or null. */
	get(id, out) {
		const slot = this.slots.get(id);
		if (slot === undefined) return null;
		return dequantize(this.q.subarray(slot * DIM, slot * DIM + DIM), this.scale[slot], out);
	}

	flush() {
		clearTimeout(this.flushTimer);
		this.flushTimer = null;
		if (!this.pending.length) return;
		const chunks = this.pending.splice(0);
		if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, MAGIC, 'ascii');
		fs.appendFileSync(this.file, Buffer.concat(chunks));
	}

	/** Rewrite the file with one record per video, optionally only for ids still in the library. */
	compact(keep) {
		this.flush();
		const ids = keep ? this.ids.filter((id) => keep.has(id)) : this.ids;
		const buf = Buffer.alloc(HEAD + ids.length * REC);
		buf.write(MAGIC, 0, 'ascii');
		const q = new Int8Array(Math.max(ids.length, 1) * DIM);
		const sc = new Float32Array(Math.max(ids.length, 1));
		const mt = new Float64Array(Math.max(ids.length, 1));
		const slots = new Map();
		ids.forEach((id, i) => {
			const old = this.slots.get(id);
			q.set(this.q.subarray(old * DIM, old * DIM + DIM), i * DIM);
			sc[i] = this.scale[old];
			mt[i] = this.mtime[old];
			slots.set(id, i);
			const o = HEAD + i * REC;
			buf.write(id.slice(0, 16), o, 'ascii');
			buf.writeDoubleLE(mt[i], o + 16);
			buf.writeFloatLE(sc[i], o + 24);
			Buffer.from(q.buffer, i * DIM, DIM).copy(buf, o + 32);
		});
		const tmp = `${this.file}.tmp`;
		fs.writeFileSync(tmp, buf);
		fs.renameSync(tmp, this.file);
		this.ids = [...ids];
		this.slots = slots;
		this.q = q; this.scale = sc; this.mtime = mt; this.capacity = Math.max(ids.length, 1);
		this.garbage = 0;
		return ids.length;
	}

	clear() {
		this.flush();
		this.slots.clear();
		this.ids = [];
		this.garbage = 0;
		try { fs.unlinkSync(this.file); } catch { /* none */ }
	}
}

module.exports = { FingerprintStore, REC };
