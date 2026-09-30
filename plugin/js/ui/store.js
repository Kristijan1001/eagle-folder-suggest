'use strict';
// Persisted settings (global file in the data folder, see core/paths.js).

const fs = require('fs');
const path = require('path');
const settingsMod = require('../core/settings');
const paths = require('../core/paths');

class Store {
	constructor() {
		this.root = paths.dataRoot();
		fs.mkdirSync(this.root, { recursive: true });
		this.file = path.join(this.root, 'settings.json');
		this.settings = this.load();
		this.saveTimer = null;
		this.listeners = new Set();
	}

	load() {
		try {
			if (fs.existsSync(this.file)) return settingsMod.normalize(JSON.parse(fs.readFileSync(this.file, 'utf8')));
		}
		catch {
			try { fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
		}
		return settingsMod.normalize({});
	}

	save() {
		clearTimeout(this.saveTimer);
		const tmp = `${this.file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(this.settings, null, 1));
		fs.renameSync(tmp, this.file);
	}

	set(patch) {
		this.settings = settingsMod.normalize({ ...this.settings, ...patch });
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => { try { this.save(); } catch { /* disk full etc. */ } }, 400);
		for (const fn of this.listeners) fn(this.settings, patch);
	}

	onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}

module.exports = { Store };
