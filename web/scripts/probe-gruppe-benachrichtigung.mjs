/** Gegenprobe: Gruppen-Nachricht → Benachrichtigung beim Empfänger.
 *  Zwei UI-Konten (mit Geräte-Registrierung), Gruppe über den Dialog,
 *  Empfänger steht NICHT im Gruppen-Chat. Erwartung: Toast/Ungelesen. */
import { chromium } from '@playwright/test';

const BASIS = 'http://127.0.0.1:5173';
const TS = Date.now();
const G1 = { username: `g1_${TS}`, email: `g1_${TS}@dev.example.com`, password: 'test1234' };
const G2 = { username: `g2_${TS}`, email: `g2_${TS}@dev.example.com`, password: 'test1234' };

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
try {
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const g1 = await register(aCtx, G1);
  const g2 = await register(bCtx, G2);
  for (const [name, page] of [['G1', g1], ['G2', g2]]) {
    page.on('console', (m) => {
      if (m.text().includes('probe') || m.text().includes('postfach') || m.text().includes('gruppe')) console.log(`${name}:`, m.text().slice(0, 160));
    });
  }

  const { id1, id2 } = {
    id1: await g1.evaluate(async () => (await (await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${localStorage.getItem('dcc.tokens.access')}` } })).json()).id),
    id2: await g2.evaluate(async () => (await (await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${localStorage.getItem('dcc.tokens.access')}` } })).json()).id)
  };
  // Freundschaft (beide Richtungen)
  for (const [page, ziel] of [[g1, id2], [g2, id1]]) {
    await page.evaluate(async (uid) => {
      await fetch('/api/chat/friend-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('dcc.tokens.access')}` },
        body: JSON.stringify({ target_user_id: uid })
      });
    }, ziel);
  }
  console.log('Freunde ✓');

  // DM-Parcours VOR der Gruppe: die Olm-Sitzungen zwischen den Geräten
  // stehen dann (eingespielte Konten — Michaels Szenario), und der
  // Gruppen-Bootstrap fährt auf bekanntem Boden.
  const dmId = await g1.evaluate(async (uid) => {
    const r = await fetch('/api/chat/dm-channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('dcc.tokens.access')}` },
      body: JSON.stringify({ target_user_id: uid })
    });
    return (await r.json()).id;
  }, id2);
  await g1.goto(`${BASIS}/app/@me/${dmId}`);
  await g2.goto(`${BASIS}/app/@me/${dmId}`);
  await g2.locator('[data-testid=active-channel-name]').waitFor({ timeout: 20_000 });
  const DM_TEXT = `vorbereitung ${TS}`;
  await g1.getByTestId('message-input').fill(DM_TEXT);
  await g1.getByTestId('message-input').press('Enter');
  await g2.locator('[data-testid="message-content"]', { hasText: DM_TEXT }).waitFor({ timeout: 20_000 });
  console.log('DM-Parcours ✓ (Geräte gepaart)');

  // Gruppe von g1 aus anlegen (mit g2)
  await g1.getByTestId('sidebar-new-group').click();
  await g1.getByTestId('chats-new-group-dialog').waitFor({ timeout: 10_000 });
  for (let i = 0; i < 6; i++) {
    await g1.getByTestId('new-group-name').fill('Benachrichtigungs-Gruppe');
    await g1.getByTestId(`new-group-friend-${id2}`).click({ timeout: 5_000 }).catch(() => console.log('g2 im Dialog disabled'));
    const bereit = await g1
      .waitForFunction(
        () => {
          const b = document.querySelector('[data-testid=new-group-create]');
          return b && !b.disabled;
        },
        undefined,
        { timeout: 3_000, polling: 200 }
      )
      .then(() => true)
      .catch(() => false);
    if (bereit) break;
  }
  await g1.getByTestId('new-group-create').click({ timeout: 10_000 });
  await g1.getByTestId('chats-new-group-dialog').waitFor({ state: 'detached', timeout: 15_000 }).catch(() => undefined);
  await g1.waitForURL(/@me\//, { timeout: 15_000 }).catch(() => undefined);
  const gruppeId = g1.url().match(/@me\/(\d+)/)?.[1] ?? null;
  console.log('Gruppe angelegt:', gruppeId, '| g1-URL:', g1.url());
  if (!gruppeId) {
    await g1.screenshot({ path: '/tmp/probe-g1-gruppe.png', fullPage: true });
    console.log('PROBE FEHLGESCHLAGEN: Gruppe nicht angelegt/geöffnet');
    await browser.close();
    process.exit(1);
  }

  // g2 bleibt auf der Freunde-Seite (Chat NICHT offen) und wartet.
  await g2.goto(`${BASIS}/app/friends`);
  await g2.waitForTimeout(2000);

  // g2s Abhol-Antworten mitlesen: kommen Umschläge an, und für wen?
  await g2.route('**/api/chat/postfach/abholen', async (route) => {
    const antwort = await route.fetch();
    try {
      const koerper = await antwort.text();
      const zustaendig = JSON.parse(koerper || '[]');
      const kompakt = (Array.isArray(zustaendig) ? zustaendig : []).map((z) => ({
        kanal: z.channel_id, art: z.art, geraet: z.empfaenger_device_pubkey?.slice(0, 8)
      }));
      console.log('G2-ABHOLEN:', antwort.status(), JSON.stringify(kompakt).slice(0, 300));
    } catch {
      console.log('G2-ABHOLEN:', antwort.status(), '(body nicht lesbar)');
    }
    await route.fulfill({ response: antwort });
  });

  // g2s Gateway-Frames direkt mitlesen — kommt postfach_neu an?
  g2.on('websocket', (ws) => {
    ws.on('framereceived', (f) => {
      const txt = String(f.payload ?? '');
      if (txt.includes('postfach_neu') || txt.includes('gruppe_neu')) {
        console.log('G2-WS ←', txt.slice(0, 140));
      }
    });
  });

  // g1 schreibt in die Gruppe
  const g1Fehler = [];
  g1.on('response', (r) => { if (r.status() >= 400) g1Fehler.push(`${r.status()} ${r.url()}`); });
  g1.on('console', (m) => console.log('G1-KONSOLE:', m.text().slice(0, 160)));
  const NACHRICHT = `alive-check ${TS}`;
  await g1.getByTestId('message-input').click();
  await g1.getByTestId('message-input').fill(NACHRICHT);
  await g1.getByTestId('message-input').press('Enter');
  await g1.waitForTimeout(2500);
  const eigeneSicht = await g1.locator('[data-testid="message-content"]', { hasText: NACHRICHT }).count();
  console.log('G1 eigene Nachricht sichtbar:', eigeneSicht > 0, '| G1-4xx:', g1Fehler.slice(0, 5));
  const toasts = await g1.locator('[data-sonner-toast]').allInnerTexts().catch(() => []);
  console.log('G1 Toasts:', JSON.stringify(toasts).slice(0, 300));
  const eingabe = await g1.evaluate(() => {
    const f = document.querySelector('[data-testid=message-input]');
    const nurLesen = f?.getAttribute('readonly') ?? f?.disabled ?? null;
    const hinweis = document.querySelector('[data-testid=message-send-error], .text-rose-500, [role=alert]');
    return { nurLesen, hinweis: hinweis?.textContent?.slice(0, 120) ?? null };
  });
  console.log('G1 Eingabe-Zustand:', JSON.stringify(eingabe));

  // Erwartung an g2: Toast (sonner) oder Ungelesen-Pill in der Liste —
  // innerhalb von 20 s.
  const toast = await g2.locator('[data-sonner-toast]').first().waitFor({ timeout: 20_000 })
    .then(() => true).catch(() => false);
  const toastText = toast ? await g2.locator('[data-sonner-toast]').first().innerText() : '';
  console.log('G2 Toast:', toast, JSON.stringify(toastText.slice(0, 120)));
  const ungelesen = await g2.evaluate((gid) => {
    const pill = document.querySelector(`[data-testid="gruppe-${gid}"] [data-testid="gruppe-unread-pill"]`);
    return pill ? pill.textContent : null;
  }, gruppeId).catch(() => null);
  console.log('G2 Ungelesen-Pill:', ungelesen);

  // Reload-Gegenprobe: funktioniert Entschlüsseln+Anzeige nach einem
  // frischen Laden (dann ist nur der LIVE-Weg krank), oder bleibt auch die
  // Liste leer (dann ist es der Gruppen-Krypto-Bootstrap auf Frischkonten)?
  await g2.reload();
  await g2.locator('[data-testid=app-shell], [data-testid=dm-channel-list]').first().waitFor({ timeout: 20_000 });
  await g2.waitForTimeout(2500);
  const nachReload = await g2.evaluate((gid) => {
    const eintrag = document.querySelector(`[data-testid="gruppe-${gid}"]`);
    const pill = eintrag?.querySelector('[data-testid="gruppe-unread-pill"]');
    return { eintrag: !!eintrag, pill: pill?.textContent ?? null };
  }, gruppeId).catch((e) => ({ fehler: String(e).slice(0, 80) }));
  console.log('G2 nach Reload:', JSON.stringify(nachReload));

  if (!toast && !ungelesen) {
    await g2.screenshot({ path: '/tmp/probe-g2-keine-benachrichtigung.png', fullPage: true });
    console.log('PROBE FEHLGESCHLAGEN: keine Benachrichtigung angekommen');
    process.exitCode = 1;
  } else {
    console.log('PROBE OK');
  }
} finally {
  await browser.close();
}
