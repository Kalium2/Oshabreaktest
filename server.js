// Optional local server: serves the site and proxies /api/* to the DOL OSHA API.
// Use it if the browser blocks direct cross-origin calls, or to keep the API key off the client.
//   DOL_API_KEY=your-key node server.js      then open http://localhost:8080
// No dependencies; requires Node 18+.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8080;
const API_KEY = process.env.DOL_API_KEY || '';
const UPSTREAM = 'https://apiprod.dol.gov/v4/get';
const ROOT = __dirname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const STATIC = new Set(['/index.html', '/app.js', '/styles.css']);

async function proxy(req, res, url) {
  // Only the OSHA datasets are reachable through this proxy.
  if (!/^\/api\/OSHA\/[a-z_]+\/json$/.test(url.pathname)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Only /api/OSHA/{dataset}/json is supported.' }));
  }
  const target = new URL(UPSTREAM + url.pathname.slice(4) + url.search);
  if (API_KEY && !target.searchParams.get('X-API-KEY')) target.searchParams.set('X-API-KEY', API_KEY);
  try {
    const upstream = await fetch(target, { headers: { Accept: 'application/json' } });
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Upstream request failed: ${e.message}` }));
  }
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) return proxy(req, res, url);
  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  if (!STATIC.has(file)) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(ROOT, file), (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`OSHA Enforcement Search on http://localhost:${PORT}${API_KEY ? '' : ' (no DOL_API_KEY set; enter a key in the page)'}`);
});
