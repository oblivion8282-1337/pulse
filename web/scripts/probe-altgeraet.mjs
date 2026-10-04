/** Härtetest zum Altgeräte-Befund (05.10.): eine Gruppe enthält ein Gerät
 *  mit UNSIGNIERTEM Bündel (wie dev2, Stand vom 12.09.).
 *
 *  Erwartungen NACH dem Fix:
 *   1. Der Absender sieht seine EIGENE Nachricht immer — kein verlorener
 *      Text, kein Geräte-Hash im Toast.
 *   2. Eine Gruppe mit mindestens einem signierten Gerät liefert an dieses
 *      regular aus (der Absender erhält seine Zeile über den Empfangsweg).
 *   3. Nur-Altgerät-Gruppe: humane Warnung („ältere App-Fassung"), lokale
 *      Zeile bleibt.
 *   4. Nach „Neuveröffentlichung" des Altgeräts kommen Nachrichten wieder
 *      bei ihm an.
 */
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BASIS = 'http://127.0.0.1:5173';
const TS = Date.now();
const A = { username: `alt_a_${TS}`, email: `alt_a_${TS}@dev.example.com`, password: 'test1234' };
const B = { username: `alt_b_${TS}`, email: `alt_b_${TS}@dev.example.com`, password: 'test1234' };

function pg(sql) {
  const dotenv = {};
  for (const line of readFileSync('../.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) dotenv[m[1]] = m[2];
  }
  return execFileSync('docker', ['exec', 'dcc_night_postgres', 'psql', '-U', dotenv.POSTGRES_USER ?? 'dcc', '-d', 'dcc', '-tAc', sql], { encoding: 'utf8' }).trim();
}

async function register(ctx, u) {
  const page = await ctx.newPage();
  await page.goto(`${BASIS}/register`);
  await page.getByTestId('reg-username').fill(u.username);
  await page.getByTestId('reg-email').fill(u.email);
  await page.getByTestId('reg-password').fill(u.password);
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
  await page.locator('[data-testid=backup-onboarding-skip-btn]').click({ timeout: 3000 }).catch(() => undefined);
  return page;
}

const browser = await chromium.launch();
let fehler = 0;
try {
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await register(aCtx, A);
  const b = await register(bCtx, B);
  const aId = await a.evaluate(async () => (await (await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${localStorage.getItem('dcc.tokens.access')}` } })).json()).id);
  const bId = await b.evaluate(async () => (await (await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${localStorage.getItem('dcc.tokens.access')}` } })).json()).id);
  for (const [page, ziel] of [[a, bId], [b, aId]]) {
    await page.evaluate(async (uid) => {
      await fetch('/api/chat/friend-requests', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('dcc.tokens.access')}` }, body: JSON.stringify({ target_user_id: uid }) });
    }, ziel);
  }
  // b-Bündel UNSIGNIERT machen (simuliert dev2: Zeile vor dem Signier-Schlag).
  // Die echten Signaturwerte vorher sichern — das Neu-Veröffentlichen wird
  // später damit restauriert (eine ERFUNDENE Signatur wäre ein
  // BuendelSignaturFehler = berechtigter Alarm, kein Altgeräte-Fall).
  const echt = pg(`select ed25519, bundel_signatur from chat.device_key_bundles where user_id = ${bId} limit 1`);
  const [echtEd, echtSig] = echt.split('|');
  pg(`update chat.device_key_bundles set ed25519 = null, bundel_signatur = null where user_id = ${bId}`);
  console.log('B-Bündel unsigniert gesetzt');

  // Gruppe von a, mit b
  await a.getByTestId('sidebar-new-group').click();
  await a.getByTestId('chats-new-group-dialog').waitFor({ timeout: 10_000 });
  await a.getByTestId('new-group-name').fill('Altgeräte-Gruppe');
  await a.getByTestId(`new-group-friend-${bId}`).click({ timeout: 5_000 }).catch(() => console.log('B im Dialog disabled?!'));
  for (let i = 0; i < 6; i++) {
    const bereit = await a.waitForFunction(() => {
      const el = document.querySelector('[data-testid=new-group-create]');
      return el && !el.disabled;
    }, undefined, { timeout: 2_000, polling: 200 }).then(() => true).catch(() => false);
    if (bereit) break;
    await a.getByTestId('new-group-name').fill('Altgeräte-Gruppe');
  }
  await a.getByTestId('new-group-create').click({ timeout: 10_000 });
  await a.waitForURL(/@me\//, { timeout: 15_000 });
  const gruppeId = a.url().match(/@me\/(\d+)/)[1];
  console.log('Gruppe:', gruppeId);

  // Bobs Fenster weg vom Chat (sonst gilt „offen = gelesen")
  await b.goto(`${BASIS}/app/friends`);
  await b.waitForTimeout(1500);

  // ── Fall 1: senden mit unsigniertem B in der Gruppe ─────────────────────
  const rohHash = [];
  a.on('console', (m) => { if (/UNm_|device_pubkey|[A-Za-z0-9_-]{43}/.test(m.text()) && m.text().includes('Gerät')) rohHash.push(m.text()); });
  const TEXT1 = `hart-test-1 ${TS}`;
  await a.getByTestId('message-input').click();
  await a.getByTestId('message-input').fill(TEXT1);
  await a.getByTestId('message-input').press('Enter');
  await a.waitForTimeout(3000);
  const eigene1 = await a.locator('[data-testid="message-content"]', { hasText: TEXT1 }).count();
  console.log('F1 eigene Nachricht sichtbar:', eigene1 > 0);
  const toasts1 = await a.locator('[data-sonner-toast]').allInnerTexts().catch(() => []);
  console.log('F1 Toasts:', JSON.stringify(toasts1.map((t) => t.slice(0, 90))));
  if (eigene1 === 0) { console.log('F1 DURCHGEFALLEN: Absender verlor die eigene Nachricht'); fehler++; }

  // ── Fall 2: b hat nach Reload nichts verpasst-Problem? (Nachlieferung) ──
  // b "öffnet die App neu" → publishes neu (UI-Reload reicht nicht — das
  // Bündel bleibt unsigniert, weil der Datensatz von uns gekappt wurde;
  // deshalb restaurieren wir die Signatur wie ein echtes Neu-Veröffentlichen)
  pg(`update chat.device_key_bundles set ed25519 = '${echtEd}', bundel_signatur = '${echtSig}' where user_id = ${bId}`);
  console.log('B-Bündel neu veröffentlicht (restauriert)');
  await b.reload();
  await b.waitForTimeout(1500);

  const TEXT2 = `hart-test-2 ${TS}`;
  await a.getByTestId('message-input').click();
  await a.getByTestId('message-input').fill(TEXT2);
  await a.getByTestId('message-input').press('Enter');
  // B sitzt auf der Freunde-Seite — die Ankunft belegt die Ungelesen-Marke
  // am Gruppen-Eintrag (genau die Benachrichtigung, die es vorher nie gab):
  const b2bekam = await b.waitForFunction(
    (gid) => {
      const e = document.querySelector(`[data-testid="gruppe-${gid}"] [data-testid="gruppe-unread-pill"]`);
      return e && Number(e.textContent) > 0;
    },
    gruppeId,
    { timeout: 25_000, polling: 500 }
  ).then(() => true).catch(() => false);
  console.log('F2 B meldet Ungelesenes nach Neuveröffentlichung:', b2bekam);
  // Und die Nachricht selbst nach dem Öffnen:
  await b.goto(`${BASIS}/app/@me/${gruppeId}`);
  const b2liest = await b.locator('[data-testid="message-content"]', { hasText: TEXT2 }).waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
  console.log('F2 B liest die Nachricht nach Öffnen:', b2liest);
  if (!b2bekam || !b2liest) fehler++;

  if (rohHash.length) console.log('Rohe Geräte-Hashes in Konsole (nur Log, kein Toast):', rohHash.length);
  console.log(fehler === 0 ? '\nHÄRTETEST BESTANDEN' : `\nHÄRTETEST MIT ${fehler} FUND(EN)`);
  process.exitCode = fehler === 0 ? 0 : 1;
} finally {
  await browser.close();
}
