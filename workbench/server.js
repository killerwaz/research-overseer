// Local workbench: a static server for workbench/, loopback only.
// Run: npm run workbench   (opens http://localhost:5690 in the default browser;
// set NO_OPEN=1 to skip that, e.g. when Claude opens it in its browser pane).
// The pages poll workbench/data/*.json, which the scripts/workbench-*.js
// scripts write — rerun a script and the open page updates itself.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ROOT = __dirname;
const PORT = Number(process.env.WORKBENCH_PORT || 5690);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  // Pages poll this tiny stamp and fetch the data only when it changed:
  // re-fetching the 1.6 MB data file every 3 s exhausted the browser
  // (ERR_INSUFFICIENT_RESOURCES) during a long session, 2026-10-12.
  if (rel === '/stamp') {
    const name = path.basename(new URL(req.url, 'http://x').searchParams.get('f') || '');
    let m = 0;
    try { m = fs.statSync(path.join(ROOT, 'data', name)).mtimeMs; } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ m }));
  }
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep) || path.basename(file) === 'server.js') {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store' });
    res.end(buf);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const url = 'http://localhost:' + PORT;
  console.log('workbench on ' + url + ' (loopback only, Ctrl+C to stop)');
  if (!process.env.NO_OPEN && process.platform === 'win32') exec('cmd /c start "" ' + url);
});
