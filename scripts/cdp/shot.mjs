// Macht einen Screenshot des ersten Pulse-Tabs (URL enthält 127.0.0.1:5173)
// auf dem CDP-Port und schreibt nach <output>.
//
//   node ../scripts/cdp/shot.mjs <port> <output> [--full]
// @playwright/test ist im web/-Workspace — Pfad relativ zu diesem Script.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(__dirname, '../../web/') + '/');
const { chromium } = require('@playwright/test');

const [,, port, output, ...rest] = process.argv;
if (!port || !output) {
  console.error('Usage: shot.mjs <port> <output> [--full]');
  process.exit(2);
}
const fullPage = rest.includes('--full');

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('127.0.0.1:5173')) ?? ctx.pages()[0];
await page.bringToFront();
await page.screenshot({ path: output, fullPage });
console.log('shot:', page.url(), '→', output);
await browser.close();
