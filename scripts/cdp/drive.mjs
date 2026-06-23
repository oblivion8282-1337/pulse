// Aktive UI-Steuerung über CDP. Hängt sich an :<port> an und führt eine
// Action gegen den ersten Pulse-Tab aus.
//
// Actions:
//   navigate <path>                — wechselt zu http://127.0.0.1:5173<path>
//   click <selector>               — klickt das erste Match
//   fill <selector> <value>        — füllt ein Input
//   eval <js>                      — führt JS in der Page aus, druckt JSON-Return
//   wait-for <selector>            — wartet bis das Element sichtbar ist (10 s)
//   login <identifier> <password>  — füllt Login-Form (testid-basiert) + submit + Wartet
//                                    bis URL nicht mehr /login enthält
//
//   node ../scripts/cdp/drive.mjs <port> <action> [args...]
import { chromium } from './pw.mjs';

const [,, port, action, ...args] = process.argv;
if (!port || !action) {
  console.error('Usage: drive.mjs <port> <action> [args...]');
  process.exit(2);
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('127.0.0.1:5173')) ?? ctx.pages()[0];
await page.bringToFront();

try {
  switch (action) {
    case 'navigate':
      await page.goto(`http://127.0.0.1:5173${args[0]}`, { waitUntil: 'networkidle' });
      console.log('at:', page.url());
      break;
    case 'click':
      await page.click(args[0]);
      console.log('clicked:', args[0]);
      break;
    case 'fill':
      await page.fill(args[0], args[1] ?? '');
      console.log('filled:', args[0]);
      break;
    case 'eval': {
      const r = await page.evaluate(args[0]);
      console.log('eval ←', JSON.stringify(r).slice(0, 400));
      break;
    }
    case 'wait-for':
      await page.waitForSelector(args[0], { state: 'visible', timeout: 10000 });
      console.log('visible:', args[0]);
      break;
    case 'login':
      await page.locator('[data-testid="login-identifier"]').fill(args[0]);
      await page.locator('[data-testid="login-password"]').fill(args[1]);
      await page.locator('[data-testid="login-submit"]').click();
      try {
        await page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 20000 });
        console.log('login done →', page.url());
      } catch {
        console.log('login wait timeout — still at:', page.url());
      }
      break;
    default:
      console.error('unknown action:', action);
      process.exit(2);
  }
} finally {
  await browser.close();
}
