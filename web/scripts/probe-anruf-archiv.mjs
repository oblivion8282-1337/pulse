/**
 * Allein-Probelauf gegen den DEV-STACK (http://127.0.0.1:5173) — die drei
 * Dinge, die die Suites nicht abdecken:
 *   1. Echter DM-Anruf zwischen zwei Browser-Fenstern (LiveKit Live-Weg)
 *   2. Archiv-Leseweg auf einem frischen Gerät IM DEV-STACK
 *   3. Passwortwechsel mit Archiv-Re-Wrap, dann Lesen mit dem NEUEN Passwort
 */
import { chromium } from '@playwright/test';

const BASIS = 'http://127.0.0.1:5173';
const TS = Date.now();
const ALICE = { username: `probe_a_${TS}`, email: `probe_a_${TS}@dev.example.com`, password: 'probe-passwort-42' };
const BOB = { username: `probe_b_${TS}`, email: `probe_b_${TS}@dev.example.com`, password: 'probe-passwort-42' };

async function register(ctx, u) {
  const page = await ctx.newPage();
  await page.goto(`${BASIS}/register`);
  await page.getByTestId('reg-username').fill(u.username);
  await page.getByTestId('reg-email').fill(u.email);
  await page.getByTestId('reg-password').fill(u.password);
  await page.getByTestId('reg-submit').click();
  try {
    await page.waitForURL(/\/app/, { timeout: 30_000 });
  } catch (e) {
    console.error('REGISTER hängt bei:', page.url());
    console.error('Fehlerbox:', await page.locator('[data-testid=reg-error], [role=alert]').allInnerTexts().catch(() => []));
    await page.screenshot({ path: '/tmp/probe-register.png', fullPage: true });
    throw e;
  }
  await page.locator('[data-testid=backup-onboarding-skip-btn]').click({ timeout: 3000 }).catch(() => undefined);
  return page;
}

async function meineId(page) {
  return page.evaluate(async () => {
    const r = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${localStorage.getItem('dcc.tokens.access')}` } });
    return (await r.json()).id;
  });
}

async function friends(pageA, uidA, pageB, uidB) {
  const send = (page, target) =>
    page.evaluate(async (uid) => {
      const r = await fetch('/api/chat/friend-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('dcc.tokens.access')}` },
        body: JSON.stringify({ target_user_id: uid })
      });
      return r.status;
    }, target);
  const a = await send(pageA, uidB);
  const b = await send(pageB, uidA);
  if (a !== 201 || b !== 201) throw new Error(`Freundschaft fehlgeschlagen: ${a}/${b}`);
}

// Virtuelles Mikro/Display — ein kopfloser Browser hat keine echten Geräte
// („Requested device not found" beim Mic-Publish im Anruf).
const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
});
try {
  // --- 1. Zwei Konten, Freunde, DM ------------------------------------------
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const alice = await register(aCtx, ALICE);
  const bob = await register(bCtx, BOB);
  const aId = await meineId(alice);
  const bId = await meineId(bob);
  await friends(alice, aId, bob, bId);
  const dmId = await alice.evaluate(async (uid) => {
    const r = await fetch('/api/chat/dm-channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('dcc.tokens.access')}` },
      body: JSON.stringify({ target_user_id: uid })
    });
    return (await r.json()).id;
  }, bId);
  console.log('DM angelegt:', dmId);

  for (const [name, page] of [['ALICE', alice], ['BOB', bob]]) {
    page.on('console', (m) => {
      const t = m.text();
      if (t.includes('[probe]') || t.includes('[anruf]') || t.includes('livekit') || t.includes('LiveKit')) {
        console.log(`${name}:`, t.slice(0, 180));
      }
    });
    page.on('pageerror', (e) => console.log(`${name}-FEHLER:`, e.message.slice(0, 200)));
  }
  await alice.goto(`${BASIS}/app/@me/${dmId}`);
  await bob.goto(`${BASIS}/app/@me/${dmId}`);
  await bob.locator('[data-testid=active-channel-name]').waitFor({ timeout: 20_000 });

  // --- 2. Eine verschlüsselte Nachricht (Archiv-Futter) ---------------------
  const KLARTEXT = `probe-nachricht ${TS}`;
  await alice.getByTestId('message-input').fill(KLARTEXT);
  await alice.getByTestId('message-input').press('Enter');
  await bob.locator('[data-testid="message-content"]', { hasText: KLARTEXT }).waitFor({ timeout: 20_000 });
  console.log('✓ Nachricht zugestellt (verschlüsselt)');

  // --- 3. DER ANRUF ----------------------------------------------------------
  await alice.getByTestId('dm-call-button').click();
  await bob.getByTestId('call-overlay').waitFor({ timeout: 15_000 });
  console.log('✓ Klingeln beim Angerufenen angekommen');
  await bob.getByTestId('call-accept').click();
  // Verbunden = Auflegen- + Stumm-Knopf da, bei beiden Seiten:
  try {
    await alice.getByTestId('call-hangup').waitFor({ timeout: 25_000 });
  } catch (e) {
    await bob.screenshot({ path: '/tmp/probe-bob-call.png', fullPage: true });
    console.log('BOB wartet auf Schlüssel:', await bob.getByTestId('call-key-waiting').count());
    throw e;
  }
  await bob.getByTestId('call-hangup').waitFor({ timeout: 25_000 });
  console.log('✓ Beide verbunden');

  // Dauer läuft (zwei Messungen im Abstand von 2,2 s unterscheiden sich):
  const dauer1 = await alice.locator('[data-testid="call-overlay"] .tabular-nums').innerText();
  await alice.waitForTimeout(2200);
  const dauer2 = await alice.locator('[data-testid="call-overlay"] .tabular-nums').innerText();
  if (dauer1 === dauer2) throw new Error(`Dauer steht: "${dauer1}"`);
  console.log(`✓ Dauer tickt (${dauer1} → ${dauer2})`);

  // E2EE-Badge oder ehrlicher Transport-Hinweis sichtbar:
  const badge = await alice.getByTestId('call-e2ee-badge').innerText();
  console.log(`  Verschlüsselungs-Badge: ${badge.trim()}`);

  await alice.getByTestId('call-hangup').click();
  await alice.getByTestId('call-overlay').waitFor({ state: 'detached', timeout: 10_000 });
  await bob.getByTestId('call-overlay').waitFor({ state: 'detached', timeout: 10_000 });
  console.log('✓ Auflegen räumt bei beiden ab');

  // --- 4. Passwortwechsel (Archiv-Re-Wrap im Live-Weg) -----------------------
  const NEU = 'probe-passwort-NEU-99';
  // Einstellungs-Dialog öffnen (Profil-Button unten links) → Sicherheits-Reiter.
  await bob.getByTestId('user-footer').click();
  await bob.getByTestId('open-settings').click();
  await bob.getByTestId('settings-dialog').waitFor({ timeout: 10_000 });
  await bob.getByTestId('settings-tab-security').click();
  await bob.getByTestId('change-password-section').waitFor({ timeout: 10_000 });
  await bob.getByTestId('change-password-current').fill(BOB.password);
  await bob.getByTestId('change-password-new').fill(NEU);
  await bob.getByTestId('change-password-confirm').fill(NEU);
  await bob.getByTestId('change-password-submit').click();
  // Erfolg: Felder werden geleert, kein Fehler-Alert.
  await bob.waitForFunction(
    () => {
      const f = document.querySelector('[data-testid="change-password-current"]');
      return f && f.value === '';
    },
    undefined,
    { timeout: 15_000, polling: 500 }
  );
  const fehler = await bob.getByTestId('change-password-error').count();
  if (fehler > 0) throw new Error('Passwortwechsel meldet Fehler');
  console.log('✓ Passwort geändert (Archiv neu gewickelt)');

  // --- 5. Zweitgerät: Archiv mit dem NEUEN Passwort lesen --------------------
  const b2Ctx = await browser.newContext();
  const bob2 = await b2Ctx.newPage();
  await bob2.goto(`${BASIS}/login`);
  await bob2.getByTestId('login-identifier').fill(BOB.email);
  await bob2.getByTestId('login-password').fill(NEU);
  await bob2.getByTestId('login-submit').click();
  await bob2.waitForURL(/\/app/, { timeout: 60_000 });
  await bob2.goto(`${BASIS}/app/@me/${dmId}`);
  await bob2.waitForFunction(
    (nadel) => document.body.innerText.includes(nadel),
    KLARTEXT,
    { timeout: 90_000, polling: 2000 }
  );
  console.log('✓ Zweitgerät liest Verlauf aus dem Archiv — mit dem NEUEN Passwort');

  console.log('\nALLE ALLEIN-PROBEN BESTANDEN');
  await aCtx.close();
  await bCtx.close();
  await b2Ctx.close();
} catch (e) {
  console.error('PROBE FEHLGESCHLAGEN:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
