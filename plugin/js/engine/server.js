'use strict';
// Local HTTP endpoint for the Inspector panel (a separate page inside Eagle's main window, reloaded
// on every selection). Listens on 127.0.0.1 only, on a random port, and every request must carry
// the random token the engine writes to engine.json next to the settings.

const http = require('http');
const crypto = require('crypto');

function start(routes, log) {
	const token = crypto.randomBytes(16).toString('hex');
	const server = http.createServer((req, res) => {
		const send = (code, obj) => {
			const body = JSON.stringify(obj);
			res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
			res.end(body);
		};
		if (req.headers['x-token'] !== token) { send(403, { ok: false, error: 'forbidden' }); return; }
		const url = new URL(req.url, 'http://127.0.0.1');
		const route = routes[`${req.method} ${url.pathname}`];
		if (!route) { send(404, { ok: false, error: 'not found' }); return; }
		let body = '';
		req.on('data', (d) => { body += d; if (body.length > 1 << 20) req.destroy(); });
		req.on('end', async () => {
			try {
				const args = body ? JSON.parse(body) : Object.fromEntries(url.searchParams);
				send(200, { ok: true, result: await route(args) });
			}
			catch (err) {
				log('warn', `Panel request ${url.pathname} failed: ${err.message}`);
				send(200, { ok: false, error: String(err.message || err) });
			}
		});
	});
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, token }));
	});
}

module.exports = { start };
