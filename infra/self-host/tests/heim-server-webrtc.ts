// Läuft aus web/ heraus:  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//   ../infra/self-host/tests/heim-server-webrtc.ts
// (Pfad zum Playwright-Import ggf. anpassen; Vite auf :5273 muss gegen den
//  lokalen Stack laufen.)
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';
import fs from 'node:fs';

const state = JSON.parse(fs.readFileSync('/tmp/heim-komplett-state.json', 'utf8'));
// heim-server-lauf.py muss den State zuletzt geschrieben haben (s. deren Ende).
const HOST = state.hostname;
const ts = Date.now();

const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: 'de-DE' });
const page = await ctx.newPage();

await page.goto('http://127.0.0.1:5273/register');
await page.getByTestId('reg-username').fill(`dc_bob_${ts}`);
await page.getByTestId('reg-email').fill(`dc_bob_${ts}@dcc-test.example.com`);
await page.getByTestId('reg-password').fill('sup3r-secret-pass');
await page.getByTestId('reg-submit').click();
await page.waitForURL(/\/app/, { timeout: 30000 });
await page.locator('[data-testid=backup-onboarding-skip-btn]').click({ timeout: 3000 }).catch(() => {});
console.log('[webrtc] bob registriert');

const tb = await page.evaluate(async (iid) => {
  const token = localStorage.getItem('dcc.tokens.access');
  await fetch(`/api/auth/me/instances/${iid}/membership`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }
  });
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`/api/auth/me/instances/${iid}/direct-endpoint`);
    if (r.ok) {
      const j = await r.json();
      if (j.online) return j;
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('telefonbuch blieb offline');
}, state.instance_id);
console.log('[webrtc] telefonbuch online:', tb.candidates[0].ip + ':' + tb.candidates[0].port);

const sess = await page.evaluate(async ({ hostname, code }) => {
  const token = localStorage.getItem('dcc.tokens.access');
  const t = await fetch('/api/auth/me/server-ticket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ hostname, community_grant_code: code })
  }).then(r => r.json());
  const s = await fetch('/api/chat/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: t.ticket, community_grant_code: code })
  }).then(r => r.json());
  return s.session_token;
}, { hostname: HOST, code: state.code });
console.log('[webrtc] session token erhalten');

const result = await page.evaluate(async ({ iid, chan, sess }) => {
  const direct = await import('/src/lib/direct/connection.ts');
  const tb = await (await fetch(`/api/auth/me/instances/${iid}/direct-endpoint`)).json();
  const t0 = Date.now();
  const conn = await direct.DirectConnection.open({
    postOffer: async (sdp) => {
      const r = await fetch(`/api/auth/me/instances/${iid}/direct-offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp })
      });
      if (!r.ok) throw new Error(`offer rejected ${r.status}`);
      return (await r.json()).sdp;
    },
    expectedFingerprint: tb.fingerprint,
    iceServers: []
  });
  const dialMs = Date.now() - t0;
  const r = await conn.fetch(`/api/chat/channels/${chan}/messages`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${sess}` }
  });
  const body = await r.text();
  conn.close();
  return { status: r.status, dialMs, body: body.slice(0, 400) };
}, { iid: state.instance_id, chan: state.chan, sess }).catch((e) => ({ fehler: String(e).slice(0, 300) }));

console.log('[webrtc] ergebnis:', JSON.stringify(result));
if (result.fehler || result.status !== 200 || !result.body.includes('willkommen auf meinem eigenen server')) {
  console.log('FEHLGESCHLAGEN');
  process.exit(1);
}
console.log('');
console.log('=== DATACHANNEL ERFOLGREICH: Bob hat den Kanal über die echte');
console.log('=== WebRTC-Direktverbindung (ohne Relay) gelesen — Dial', result.dialMs, 'ms ===');
await browser.close();
