/** Gegenprobe zu Michaels Gruppen-Befund (05.10.): Gruppe anlegen, öffnen,
 *  Name + Ladeweg beobachten. Gegen den Dev-Stack (5173). */
import { chromium } from '@playwright/test';

const BASIS = 'http://127.0.0.1:5173';
const TS = Date.now();

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (t.includes('404') || t.includes('gruppe') || t.includes('Gruppe') || t.includes('Failed')) {
    console.log('KONSOLE:', t.slice(0, 180));
  }
});
const netzfehler = [];
page.on('response', (r) => {
  if (r.status() >= 400) netzfehler.push(`${r.status()} ${r.url()}`);
});

try {
  // dev3 anmelden (existiert: test1234)
  await page.goto(`${BASIS}/login`);
  await page.getByTestId('login-identifier').fill('dev3');
  await page.getByTestId('login-password').fill('test1234');
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });

  // Einen Freund dazunehmen (API, beide Richtungen = auto-accept)
  const { meineId, freundId } = await page.evaluate(async (ts) => {
    const tok = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('dcc.tokens.access')}` });
    const reg = await fetch('/api/auth/register', {
      method: 'POST',
      headers: tok(),
      body: JSON.stringify({ username: `dev4_${ts}`, email: `dev4_${ts}@dev.example.com`, password: 'test1234', display_name: 'dev4' })
    });
    const regBody = await reg.json();
    const mich = (await (await fetch('/api/auth/me', { headers: tok() })).json());
    // Register antwortet mit Tokens, nicht mit dem Konto — die Id steckt im
    // JWT-sub (Mitte des Tokens, base64).
    let freundId = null;
    try {
      const nutzlast = JSON.parse(atob(regBody.access_token.split('.')[1]));
      freundId = nutzlast.sub;
      await fetch('/api/chat/friend-requests', { method: 'POST', headers: tok(), body: JSON.stringify({ target_user_id: freundId }) });
      // Gegenanfrage ALS dev4 — beide Richtungen = auto-accept.
      await fetch('/api/chat/friend-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${regBody.access_token}` },
        body: JSON.stringify({ target_user_id: mich.id })
      });
    } catch {}
    return { meineId: mich.id, freundId };
  }, TS);
  console.log('meineId:', meineId, 'freund:', freundId);

  // Gruppe über das UI anlegen
  await page.getByTestId('sidebar-new-group').click();
  await page.getByTestId('chats-new-group-dialog').waitFor({ timeout: 10_000 });
  // Fill + Enable-Sync: Svelte braucht einen Tack, bis disabled vom
  // name-Bindung abfällt — notfalls nochmal füllen.
  for (let i = 0; i < 5; i++) {
    await page.getByTestId('new-group-name').fill('Probe-Gruppe');
    const bereit = await page
      .waitForFunction(
        () => {
          const b = document.querySelector('[data-testid=new-group-create]');
          const f = document.querySelector('[data-testid=new-group-name]');
          return b && !b.disabled && f && f.value !== '';
        },
        undefined,
        { timeout: 3_000, polling: 200 }
      )
      .then(() => true)
      .catch(() => false);
    if (bereit) break;
  }
  // Freund wählen, wenn wählbar (API-Konten haben keine Geräte-Keys und
  // sind disabled) — für den Ladeweg-Beweis reicht eine Mitglieder-lose
  // Gruppe.
  await page
    .getByTestId(`new-group-friend-${freundId}`)
    .click({ timeout: 3_000 })
    .catch(() => console.log('Freund disabled (kein Gerät) — Gruppe ohne Mitglieder'));
  const diag = await page.evaluate(() => ({
    namenfelder: document.querySelectorAll('[data-testid=new-group-name]').length,
    werte: [...document.querySelectorAll('[data-testid=new-group-name]')].map((f) => f.value),
    dialoge: document.querySelectorAll('[data-testid=chats-new-group-dialog]').length
  }));
  console.log('DIALOG-DIAG:', JSON.stringify(diag));
  await page.screenshot({ path: '/tmp/probe-dialog.png' });
  await page.getByTestId('new-group-create').click({ timeout: 10_000 });
  await page.getByTestId('chats-new-group-dialog').waitFor({ state: 'detached', timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(1500);

  // Wo stehen wir? Header-Name der offenen Ansicht:
  const kopf = await page.getByTestId('active-channel-name').innerText().catch(() => '(kein active-channel-name)');
  console.log('Kopfzeilen-Name:', JSON.stringify(kopf));

  // Nachrichtenbereich? Fehler-Netzwerkliste:
  console.log('Netz-4xx/5xx:', netzfehler.slice(0, 6));

  // Zweiter Einstieg: über /app/friends die Bestandsgruppe anklicken (der
  // Weg, der früher tot war — die Sektion hing am onSelectGruppe-Prop).
  netzfehler.length = 0;
  await page.goto(`${BASIS}/app/friends`);
  await page.locator('[data-testid^=gruppe-]').first().click({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  const kopf2 = await page.getByTestId('active-channel-name').innerText().catch(() => '(fehlt)');
  console.log('Kopf (via Freunde):', JSON.stringify(kopf2));
  console.log('Netz-4xx/5xx (via Freunde):', netzfehler.slice(0, 6));
} finally {
  await browser.close();
}
