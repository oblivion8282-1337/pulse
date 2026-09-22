/**
 * Overnight T7 — Direktnachrichten:
 * Freunde → DM-Kanal anlegen → senden/antworten, Unread-Punkt für den
 * Empfänger, Sortierung (neueste Aktivität oben) und der E2EE-Pfad
 * (Schalter per Route-Patch + Electron-Stub, Muster aus e2e-dm.spec.ts).
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  schalterEinschalten,
  alsElektronGeraetAusgeben,
  warteAufSchluesselbuendel
} from './_hetzner-helfer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');

const ts = Date.now();
const ALICE = {
  username: `dm_alice_${ts}`,
  email: `dm_alice_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const BOB = {
  username: `dm_bob_${ts}`,
  email: `dm_bob_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const CARL = {
  username: `dm_carl_${ts}`,
  email: `dm_carl_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};

async function register(page: Page, u: { username: string; email: string; password: string }) {
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(u.username);
  await page.getByTestId('reg-email').fill(u.email);
  await page.getByTestId('reg-password').fill(u.password);
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/);
  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 2500 })
    .catch(() => undefined);
}

async function currentUserId(page: Page): Promise<string> {
  const value = await page.evaluate(() => {
    const raw = localStorage.getItem('dcc.tokens.access');
    if (!raw) return null;
    const parts = raw.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.sub as string;
  });
  if (!value) throw new Error('kein Access-Token im localStorage');
  return value;
}

/** Freundschaft per Kreuz-Anfrage (zweite akzeptiert automatisch). */
async function becomeFriends(pageA: Page, uidA: string, pageB: Page, uidB: string) {
  const send = async (page: Page, targetId: string) => {
    const r = await page.evaluate(async (uid) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const resp = await fetch('/api/chat/friend-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ target_user_id: uid })
      });
      return { status: resp.status, body: await resp.text() };
    }, targetId);
    if (r.status !== 201 && r.status !== 409 && r.status !== 400) {
      throw new Error(`friend-request failed ${r.status}: ${r.body}`);
    }
  };
  await send(pageA, uidB);
  await send(pageB, uidA);
}

async function createDmChannel(page: Page, targetUserId: string): Promise<string> {
  const resp = await page.evaluate(async (uid) => {
    const token = localStorage.getItem('dcc.tokens.access');
    const r = await fetch('/api/chat/dm-channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ target_user_id: uid })
    });
    return { status: r.status, body: await r.text() };
  }, targetUserId);
  if (resp.status !== 200 && resp.status !== 201) {
    throw new Error(`dm-channels failed ${resp.status}: ${resp.body}`);
  }
  return (JSON.parse(resp.body) as { id: string }).id;
}

/** Direkte Postgres-Gegenprobe — derselbe Container wie in e2e-dm.spec.ts. */
function pgQuery(sql: string): string {
  const dotenv: Record<string, string> = {};
  try {
    for (const line of readFileSync(resolve(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) dotenv[m[1]] = m[2];
    }
  } catch {
    // .env fehlt → Vorgaben greifen.
  }
  const pgUser = dotenv.POSTGRES_USER ?? 'dcc';
  return execFileSync(
    'docker',
    ['exec', 'dcc_night_postgres', 'psql', '-U', pgUser, '-d', 'dcc_test', '-tAc', sql],
    { encoding: 'utf8' }
  ).trim();
}

async function senden(page: Page, text: string) {
  const input = page.getByTestId('message-input');
  await input.fill(text);
  await input.press('Enter');
}

test.describe.serial('Overnight T7 — DMs im Klartext-Pfad', () => {
  let aliceCtx: BrowserContext;
  let alicePage: Page;
  let bobCtx: BrowserContext;
  let bobPage: Page;
  let carlCtx: BrowserContext;
  let carlPage: Page;
  let dmAliceBob = '';

  test.beforeAll(async ({ browser }) => {
    aliceCtx = await browser.newContext();
    bobCtx = await browser.newContext();
    carlCtx = await browser.newContext();
    for (const ctx of [aliceCtx, bobCtx, carlCtx]) {
      await ctx.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
    }
    alicePage = await aliceCtx.newPage();
    bobPage = await bobCtx.newPage();
    carlPage = await carlCtx.newPage();
  });

  test.afterAll(async () => {
    await aliceCtx.close();
    await bobCtx.close();
    await carlCtx.close();
  });

  test('Aufbau: drei Nutzer, Alice und Bob per UI befreundet', async () => {
    await register(alicePage, ALICE);
    await register(bobPage, BOB);
    await register(carlPage, CARL);

    // Anfrage über die UI: Tab „Freund hinzufügen“ → suchen → hinzufügen.
    await alicePage.goto('/app/friends?tab=add');
    await alicePage.getByTestId('add-friend-input').fill(BOB.username);
    await expect(alicePage.getByTestId('search-hit')).toBeVisible({ timeout: 10_000 });
    await alicePage.getByTestId('search-hit-add').click();
    await expect(alicePage.getByTestId('search-hit-status')).toContainText('Anfrage offen', {
      timeout: 5000
    });

    // Bob nimmt über die UI an.
    await bobPage.goto('/app/friends?tab=pending');
    const zeile = bobPage.getByTestId('pending-in-row');
    await expect(zeile).toBeVisible({ timeout: 10_000 });
    await zeile.getByTestId('pending-accept-btn').click();
    await expect(zeile).toHaveCount(0, { timeout: 10_000 });
  });

  test('DM anlegen (Freundes-Button) → Nachricht erscheint', async () => {
    await alicePage.goto('/app/friends?tab=all');
    const freundin = alicePage.getByTestId('friend-row').filter({ hasText: BOB.username });
    await expect(freundin).toBeVisible({ timeout: 10_000 });
    await freundin.getByTestId('friend-dm-btn').click();

    await alicePage.waitForURL(/\/app\/@me\/(\d+)/, { timeout: 10_000 });
    dmAliceBob = new URL(alicePage.url()).pathname.split('/').pop()!;
    expect(dmAliceBob).toMatch(/^\d+$/);

    await senden(alicePage, 'erste private zeile');
    await expect(
      alicePage.locator('[data-testid="message-content"]', { hasText: 'erste private zeile' })
    ).toBeVisible({ timeout: 10_000 });
  });

  test('Bob sieht die DM in seiner Liste, öffnet sie und antwortet', async () => {
    await bobPage.goto('/app/@me');
    const kachel = bobPage.getByTestId(`dm-${dmAliceBob}`);
    await expect(kachel).toBeVisible({ timeout: 10_000 });
    await kachel.click();
    await bobPage.waitForURL(new RegExp(`/app/@me/${dmAliceBob}`));

    await expect(
      bobPage.locator('[data-testid="message-content"]', { hasText: 'erste private zeile' })
    ).toBeVisible({ timeout: 10_000 });

    await senden(bobPage, 'und zurück');
    await expect(
      alicePage.locator('[data-testid="message-content"]', { hasText: 'und zurück' })
    ).toBeVisible({ timeout: 10_000 });
  });

  test('Unread-Punkt + Sortierung: neue DM rutscht nach oben', async () => {
    // Carl ↔ Bob: Freundschaft und Kanal per API (UI-Pfad oben schon gedeckt).
    await becomeFriends(carlPage, await currentUserId(carlPage), bobPage, await currentUserId(bobPage));
    const dmCarlBob = await createDmChannel(carlPage, await currentUserId(bobPage));

    // Bob steht in Allices DM — Carls Kachel ist unten (leer sortiert nach id).
    await bobPage.goto(`/app/@me/${dmAliceBob}`);
    const carlKachel = bobPage.getByTestId(`dm-${dmCarlBob}`);
    const aliceKachel = bobPage.getByTestId(`dm-${dmAliceBob}`);
    await expect(carlKachel).toBeVisible({ timeout: 10_000 });

    const carlVorher = (await carlKachel.boundingBox())!.y;
    const aliceVorher = (await aliceKachel.boundingBox())!.y;
    expect(carlVorher).toBeGreaterThan(aliceVorher);

    // Carl schreibt → Bob sieht den Unread-Punkt an Carls Kachel …
    await carlPage.goto(`/app/@me/${dmCarlBob}`);
    await senden(carlPage, 'ping von carl');
    await expect(carlKachel.getByTestId('dm-unread-dot')).toBeVisible({ timeout: 10_000 });

    // … und die Kachel ist nach oben gerutscht (neueste Aktivität zuerst).
    await expect
      .poll(
        async () => {
          const carlY = (await carlKachel.boundingBox())?.y ?? Number.MAX_SAFE_INTEGER;
          const aliceY = (await aliceKachel.boundingBox())?.y ?? Number.MAX_SAFE_INTEGER;
          return aliceY - carlY;
        },
        { timeout: 10_000 }
      )
      .toBeGreaterThan(0);

    // Öffnen räumt den Unread-Punkt weg.
    await carlKachel.click();
    await bobPage.waitForURL(new RegExp(`/app/@me/${dmCarlBob}`));
    await expect(carlKachel.getByTestId('dm-unread-dot')).toHaveCount(0, { timeout: 10_000 });
  });
});

test.describe.serial('Overnight T7 — verschlüsselte DM (E2EE)', () => {
  let eveCtx: BrowserContext;
  let evePage: Page;
  let frankCtx: BrowserContext;
  let frankPage: Page;
  let dmEveFrank = '';

  test.beforeAll(async ({ browser }) => {
    eveCtx = await browser.newContext();
    frankCtx = await browser.newContext();
    for (const ctx of [eveCtx, frankCtx]) {
      await ctx.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
      // Schalter + Electron-Stub: nur so verschlüsselt der Client wirklich
      // (Koexistenz-Regel verlangt dauerhafte Geräte auf beiden Seiten).
      await schalterEinschalten(ctx);
      await alsElektronGeraetAusgeben(ctx);
    }
    evePage = await eveCtx.newPage();
    frankPage = await frankCtx.newPage();
  });

  test.afterAll(async () => {
    await eveCtx.close();
    await frankCtx.close();
  });

  test('Aufbau: Freunde per API, Schlüsselbündel veröffentlicht, DM per UI', async () => {
    const EVE = { username: `dm_eve_${ts}`, email: `dm_eve_${ts}@dcc-test.example.com`, password: 'sup3r-secret-pass' };
    const FRANK = { username: `dm_frank_${ts}`, email: `dm_frank_${ts}@dcc-test.example.com`, password: 'sup3r-secret-pass' };
    await register(evePage, EVE);
    await register(frankPage, FRANK);

    const eveId = await currentUserId(evePage);
    const frankId = await currentUserId(frankPage);
    await becomeFriends(evePage, eveId, frankPage, frankId);
    await warteAufSchluesselbuendel(evePage, eveId);
    await warteAufSchluesselbuendel(frankPage, frankId);

    await evePage.goto('/app/friends?tab=all');
    const zeile = evePage.getByTestId('friend-row').filter({ hasText: FRANK.username });
    await expect(zeile).toBeVisible({ timeout: 10_000 });
    await zeile.getByTestId('friend-dm-btn').click();
    await evePage.waitForURL(/\/app\/@me\/(\d+)/, { timeout: 10_000 });
    dmEveFrank = new URL(evePage.url()).pathname.split('/').pop()!;
    expect(dmEveFrank).toMatch(/^\d+$/);
  });

  test('Eve schreibt, Frank liest Klartext — der Server hat nur Ciphertext', async () => {
    const GEHEIM = 'nur frank darf das lesen';
    await frankPage.goto(`/app/@me/${dmEveFrank}`);
    await expect(frankPage.getByTestId('active-channel-name')).toBeVisible({ timeout: 10_000 });

    await evePage.goto(`/app/@me/${dmEveFrank}`);
    await senden(evePage, GEHEIM);

    // Frank liest den Klartext, live per Postfach-Zustellung.
    await expect(
      frankPage.locator('[data-testid="message-content"]', { hasText: GEHEIM })
    ).toBeVisible({ timeout: 15_000 });

    // Und die Gegenprobe: keine Klartext-Zeile auf dem Server (Muster aus
    // e2e-dm.spec.ts — dieselbe dcc_test-DB wie der Rest der Suite).
    const zeilen = Number(
      pgQuery(`SELECT count(*) FROM chat.messages WHERE channel_id = ${dmEveFrank};`)
    );
    expect(zeilen).toBe(0);
  });

  test('Verlauf bleibt nach Reload lesbar (lokaler Verlauf)', async () => {
    await frankPage.reload();
    await frankPage.waitForURL(new RegExp(`/app/@me/${dmEveFrank}`));
    await expect(
      frankPage.locator('[data-testid="message-content"]', { hasText: 'nur frank darf das lesen' })
    ).toBeVisible({ timeout: 15_000 });
  });
});
