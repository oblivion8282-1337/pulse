/**
 * Lokaler Auto-Update-Feed für den End-to-End-Test OHNE Image-Push.
 *
 * Serviert ein Verzeichnis (default `desktop/release/`) über HTTP auf
 * http://localhost:8888/ — genau die URL, auf die `desktop/dev-app-update.yml`
 * zeigt. electron-updater (mit `PULSE_DEV_UPDATE=1`) pollt `latest.yml`, lädt
 * die referenzierte `Pulse-Setup-*.exe` und (per Range) die `.blockmap`.
 *
 * Nur Node-Builtins, keine Dependencies (Python-frei). Range-Support ist für
 * den differentiellen Download / Resume da; ein frischer Full-Download geht auch
 * ohne. Bindet bewusst nur an 127.0.0.1.
 *
 *   node scripts/local-update-feed.mjs [dir]     # default: release
 *   PORT=9000 node scripts/local-update-feed.mjs
 */
import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, normalize, extname } from 'node:path';

const ROOT = join(process.cwd(), process.argv[2] ?? 'release');
const PORT = Number(process.env.PORT) || 8888;
const TYPES = {
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.json': 'application/json',
  '.exe': 'application/octet-stream',
  '.blockmap': 'application/octet-stream',
};

createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    // Path-Traversal blocken: normalisieren und unter ROOT einsperren.
    const filePath = join(ROOT, normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const st = await stat(filePath).catch(() => null);
    if (!st?.isFile()) {
      console.log(`[feed] ${req.method} ${urlPath} -> 404`);
      res.writeHead(404).end('not found');
      return;
    }
    const type = TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    const rangeMatch = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (rangeMatch) {
      const start = rangeMatch[1] ? Number(rangeMatch[1]) : 0;
      const end = rangeMatch[2] ? Math.min(Number(rangeMatch[2]), st.size - 1) : st.size - 1;
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      console.log(`[feed] ${req.method} ${urlPath} -> 206 ${start}-${end}`);
      if (req.method === 'HEAD') return res.end();
      createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
      console.log(`[feed] ${req.method} ${urlPath} -> 200 (${st.size}B)`);
      if (req.method === 'HEAD') return res.end();
      createReadStream(filePath).pipe(res);
    }
  } catch (e) {
    console.error('[feed] error', e);
    res.writeHead(500).end('error');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`[feed] serving ${ROOT} at http://localhost:${PORT}/`));
