/**
 * Gerätewechsel-Nachweis des 120-Tage-Archivs (2026-10-05): Michaels
 * Szenario „Browser 1 senden/empfangen → Browser zu → Browser 2 anmelden →
 * Verlauf muss da sein". Der Verlauf kommt aus dem verschlüsselten
 * Server-Archiv (Übergabe §5), nicht aus dem lokalen Bestand — Browser 2
 * hat ja keinen.
 *
 * Deckt zwei Vorfalls-Runden vom 05.10. ab: Archiv-Aufrufe müssen an die
 * CLOUD geroutet sein (Self-Host aktiv = 404), und der Abmelde-Wisch darf
 * die frisch erzeugte Identität der Neuanmeldung nicht wegfegen.
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const ALICE = {
  username: 'gw_a_' + Date.now().toString(36),
  email: `gw_a_${Date.now().toString(36)}@example.org`,
  password: 'repro-gw-1A!'
};
const BOB = {
  username: 'gw_b_' + Date.now().toString(36),
  email: `gw_b_${Date.now().toString(36)}@example.org`,
  password: 'repro-gw-1A!'
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

async function login(page: Page, u: { username: string; password: string }) {
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill(u.username);
  await page.getByTestId('login-password').fill(u.password);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/app/);
}

async function currentUserId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('dcc.tokens.access');
    if (!raw) throw new Error('no access token');
    const parts = raw.split('.');
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.sub as string;
  });
}

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
    if (r.status !== 201) throw new Error(`friend-request failed ${r.status}: ${r.body}`);
  };
  await send(pageA, uidB);
  await send(pageB, uidA);
}

async function sendDm(page: Page, text: string) {
  await page.getByTestId('message-input').click();
  await page.getByTestId('message-input').fill(text);
  await page.getByTestId('message-input').press('Enter');
}

test.describe.serial('Archiv-Gerätewechsel: Verlauf auf jedem Gerät (§5)', () => {
  test('Browser 1: Unterhaltung, Browser 2: gleicher Nutzer sieht den Verlauf', async ({
    browser
  }) => {
    const ctxA = await browser.newContext();
    const ctxB1 = await browser.newContext();
    for (const ctx of [ctxA, ctxB1]) {
      await ctx.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
    }
    const alice = await ctxA.newPage();
    const bob1 = await ctxB1.newPage();

    await register(alice, ALICE);
    await register(bob1, BOB);
    const uidA = await currentUserId(alice);
    const uidB = await currentUserId(bob1);
    await becomeFriends(alice, uidA, bob1, uidB);

    const r = await alice.evaluate(async (uid) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const resp = await fetch('/api/chat/dm-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ target_user_id: uid })
      });
      return { status: resp.status, body: await resp.json() };
    }, uidB);
    expect(r.status, `dm-channels: ${JSON.stringify(r.body)}`).toBe(201);
    const dmId = r.body.id;

    // Unterhaltung in Browser 1 — BEIDE Richtungen, damit beide Seiten
    // archivieren (jede Sendung wird vom ABSENDENDEN Gerät archiviert).
    await alice.goto(`/app/@me/${dmId}`);
    await expect(alice.getByTestId('message-input')).toBeVisible({ timeout: 10_000 });
    await sendDm(alice, 'archiv hin');
    await bob1.goto(`/app/@me/${dmId}`);
    await expect(bob1.getByTestId('message-input')).toBeVisible({ timeout: 10_000 });
    await expect(
      bob1.locator('[data-testid="message-content"]', { hasText: 'archiv hin' })
    ).toBeVisible({ timeout: 10_000 });
    await sendDm(bob1, 'archiv rueck');

    // Abmelden (vollständiger Identitäts-Wisch) + Browser zu.
    await bob1.getByTestId('user-footer-trigger').click();
    await bob1.getByTestId('sign-out').click();
    await bob1.waitForURL(/\/login/);
    await ctxB1.close();

    // Browser 2: frischer Anmeldung, Unterhaltung öffnen — der Verlauf
    // muss aus dem Server-Archiv kommen.
    const ctxB2 = await browser.newContext();
    await ctxB2.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
    const bob2 = await ctxB2.newPage();
    await login(bob2, BOB);
    await bob2.goto(`/app/@me/${dmId}`);
    await expect(bob2.getByTestId('message-input')).toBeVisible({ timeout: 10_000 });
    await expect(
      bob2.locator('[data-testid="message-content"]', { hasText: 'archiv hin' })
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      bob2.locator('[data-testid="message-content"]', { hasText: 'archiv rueck' })
    ).toBeVisible({ timeout: 20_000 });

    // Und der Zweitgerät-Verlauf bleibt auch nach einem Kanalwechsel erhalten.
    await bob2.goto('/app/@me');
    await bob2.goto(`/app/@me/${dmId}`);
    await expect(
      bob2.locator('[data-testid="message-content"]', { hasText: 'archiv hin' })
    ).toBeVisible({ timeout: 10_000 });

    await ctxA.close();
    await ctxB2.close();
  });
});
