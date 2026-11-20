// Local HTTP endpoint for the Chrome button. Listens on 127.0.0.1 only and
// accepts requests from Chrome extensions (or local tools with no Origin);
// requests from ordinary web pages are refused, so a website can't write to
// the vault.
'use strict';
const http = require('http');

const PORT = 47817;

function start(getActions, { port = PORT, log = () => {} } = {}) {
  const routes = {
    'GET /ping': () => ({ ok: true, app: 'Brain Desk' }),
    'POST /lookup': b => getActions().lookup(b),
    'POST /log-person': b => getActions().chromeLogPerson(b),
    'POST /log-reply': b => { getActions().logReply(b.id, { note: b.note, channel: 'linkedin' }); return { ok: true }; },
    'POST /add-inbound': b => getActions().addInbound({ ...b, source: 'chrome' }),
    'POST /add-prospect': b => getActions().chromeAddProspect(b),
    'POST /draft': b => getActions().chromeDraft(b),
    'POST /save-draft': b => getActions().chromeSaveDraft(b),
  };

  const server = http.createServer((req, res) => {
    const origin = req.headers.origin || '';
    const allowed = !origin || origin.startsWith('chrome-extension://');
    const send = (code, obj) => {
      const headers = { 'Content-Type': 'application/json' };
      if (allowed && origin) { headers['Access-Control-Allow-Origin'] = origin; headers['Access-Control-Allow-Headers'] = 'Content-Type'; }
      res.writeHead(code, headers);
      res.end(JSON.stringify(obj));
    };
    if (!allowed) return send(403, { error: 'Only the Brain Desk Chrome button can call this.' });
    if (req.method === 'OPTIONS') return send(204, {});
    const route = routes[`${req.method} ${req.url.split('?')[0]}`];
    if (!route) return send(404, { error: 'Not found' });
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      try {
        if (!getActions()) return send(503, { error: 'Brain Desk has no vault connected yet.' });
        const parsed = body ? JSON.parse(body) : {};
        send(200, (await route(parsed)) || { ok: true });
      } catch (e) {
        log('server error', e);
        send(400, { error: e.message });
      }
    });
  });
  server.on('error', e => log('server failed', e));
  server.listen(port, '127.0.0.1');
  return server;
}

module.exports = { start, PORT };
