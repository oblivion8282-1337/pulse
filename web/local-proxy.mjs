// Lokaler Testserver für die Mobile-App im Emulator:
// - serves the committed static build (web/build)
// - proxies /api/* (HTTP + WebSocket) to https://howispulse.com
// Run: node local-proxy.mjs  (Port 4173)
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'build');
const PORT = 4173;
const UPSTREAM = 'howispulse.com';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain',
  '.webmanifest': 'application/manifest+json'
};

function proxy(req, res) {
  const opts = {
    hostname: UPSTREAM, port: 443, method: req.method,
    path: req.url,
    headers: { ...req.headers, host: UPSTREAM }
  };
  const up = https.request(opts, (ur) => {
    res.writeHead(ur.statusCode, ur.headers);
    ur.pipe(res);
  });
  up.on('error', () => { res.writeHead(502); res.end('proxy error'); });
  req.pipe(up);
}

function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(ROOT, 'index.html'); // SPA fallback
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return proxy(req, res);
  serveStatic(req, res);
});

server.on('upgrade', (req, socket, head) => {
  const up = https.request({
    hostname: UPSTREAM, port: 443, method: 'GET',
    path: req.url,
    headers: { ...req.headers, host: UPSTREAM, connection: 'Upgrade' }
  });
  up.on('upgrade', (ur, usocket, uhead) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      Object.entries(ur.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n'
    );
    usocket.pipe(socket); socket.pipe(usocket);
  });
  up.on('error', () => socket.destroy());
  up.end(head);
});

server.listen(PORT, '0.0.0.0', () => console.log(`local proxy on :${PORT}`));
