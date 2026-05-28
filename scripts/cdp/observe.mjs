// Passiver CDP-Listener: hängt sich an Chromium auf 127.0.0.1:<port> an
// und schreibt Events nach /tmp/pulse-cdp-events-<port>.log.
//
// Aus web/ aufrufen (wegen @playwright/test-Resolver):
//   cd web; nohup node ../scripts/cdp/observe.mjs 9222 > /dev/null 2>&1 &
//
// Was geloggt wird:
//   - Console: log/info/warn/error (debug/verbose werden gefiltert)
//   - Unhandled pageerrors
//   - Network-Requests die fehlschlagen (DNS, refused, …)
//   - HTTP-Responses mit Status ≥ 400
//   - Hauptframe-Navigationen
// @playwright/test ist nur im web/-Workspace installiert. Wir lösen den
// Pfad relativ zu diesem Script auf, damit der Aufruf aus jedem cwd geht.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(__dirname, '../../web/') + '/');
const { chromium } = require('@playwright/test');

import { appendFileSync } from 'node:fs';

const port = process.argv[2];
if (!port) { console.error('Usage: observe.mjs <port>'); process.exit(2); }

const LOG = `/tmp/pulse-cdp-events-${port}.log`;
const stripHost = (s) => s.replace(/^https?:\/\/127\.0\.0\.1:5173/, '');

function line(...parts) {
  const ts = new Date().toISOString().slice(11, 19);
  appendFileSync(LOG, `[${ts}] ${parts.join(' ')}\n`);
}

function attachPage(page) {
  const tag = () => `<${stripHost(page.url())}>`;
  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'debug' || t === 'verbose') return;
    line(tag(), `console.${t}:`, msg.text().slice(0, 400));
  });
  page.on('pageerror', (err) => {
    line(tag(), 'pageerror:', err.message.slice(0, 400));
  });
  page.on('requestfailed', (req) => {
    line(tag(), 'requestfailed:', req.method(), req.url(), '←', req.failure()?.errorText);
  });
  page.on('response', (resp) => {
    if (resp.status() >= 400) {
      line(tag(), `HTTP ${resp.status()}:`, resp.request().method(), resp.url());
    }
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) line('nav:', frame.url());
  });
  line('attached:', page.url());
}

function attachContext(ctx) {
  for (const p of ctx.pages()) attachPage(p);
  ctx.on('page', attachPage);
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
line(`--- observer connected (port ${port}) ---`);
for (const ctx of browser.contexts()) attachContext(ctx);
if (typeof browser.on === 'function') browser.on('context', attachContext);
browser.on('disconnected', () => line('--- observer disconnected ---'));

await new Promise(() => {}); // forever
