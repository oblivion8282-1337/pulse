/**
 * Repro 2026-10-05: „nach Abmelden+Anmelden kommen gegenseitig keine
 * Nachrichten mehr an" (Prod-Befund oblivion↔dev, ab ~09:44 UTC).
 *
 * Verdacht: signOut() wischt Pickel-Geheimnis + Gerätekennung (bewusst,
 * s. account.svelte.ts-Modulkopf), aber NICHT den eingefrorenen Krypto-
 * Account und NICHT den Geräteschlüssel — der Re-Login muss den Zustand
 * dann konsistent neu aufbauen. Dieser Spec erzwingt genau diesen Zyklus
 * und behauptet: danach geht der Empfang BOTH directions weiter.
 *
 * Läuft wie dms.spec.ts gegen die eigenen E2E-Dienste (Playwright-Config).
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const ALICE = {
  username: 'relo_a_' + Date.now().toString(36),
  email: `relo_a_${Date.now().toString(36)}@example.org`,
  password: 'repro-relo-1A!'
};
const BOB = {
  username: 'relo_b_' + Date.now().toString(36),
  email: `relo_b_${Date.now().toString(36)}@example.org`,
  password: 'repro-relo-1A!'
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

test.describe.serial('DM nach Abmelden+Anmelden (Repro 2026-10-05)', () => {
  let aliceCtx: BrowserContext;
  let alicePage: Page;
  let bobCtx: BrowserContext;
  let bobPage: Page;
  const konsole: string[] = [];

  test.beforeAll(async ({ browser }) => {
    aliceCtx = await browser.newContext();
    bobCtx = await browser.newContext();
    for (const ctx of [aliceCtx, bobCtx]) {
      await ctx.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
    }
    alicePage = await aliceCtx.newPage();
    bobPage = await bobCtx.newPage();
    const sammle = (name: string, page: Page) =>
      page.on('console', (msg) => {
        if (msg.type() === 'error' || msg.type() === 'warning') {
          konsole.push(`[${name} ${msg.type()}] ${msg.text().slice(0, 300)}`);
        }
      });
    sammle('alice', alicePage);
    sammle('bob', bobPage);
    alicePage.on('request', (req) => {
      if (req.url().includes('/postfach') && req.method() === 'POST') {
        konsole.push(
          `[net] ${new Date().toISOString().slice(14, 23)} POST ${req.url().slice(-40)} ${req.postData()?.slice(0, 120) ?? ''}`
        );
      }
    });
    alicePage.on('response', async (resp) => {
      if (resp.url().includes('/api/chat/postfach') && resp.request().method() === 'POST') {
        let koerper = '';
        try {
          koerper = (await resp.text()).slice(0, 200);
        } catch { /* body nicht lesbar */ }
        konsole.push(
          `[net-antwort] ${resp.status()} ${resp.url().slice(-40)} ${koerper}`
        );
      }
    });
    for (const p of [alicePage, bobPage]) {
      p.on('pageerror', (err) => konsole.push(`[pageerror] ${String(err).slice(0, 300)}`));
    }
  });

  test.afterAll(async () => {
    await aliceCtx.close();
    await bobCtx.close();
    if (konsole.length > 0) {
      console.log('--- BOB-KONSOLE (letzte 15) ---');
      for (const z of konsole.slice(-15)) console.log(z);
    }
  });

  test('baseline: DM läuft vor dem Zyklus', async () => {
    await register(alicePage, ALICE);
    await register(bobPage, BOB);
    const uidA = await currentUserId(alicePage);
    const uidB = await currentUserId(bobPage);
    await becomeFriends(alicePage, uidA, bobPage, uidB);

    const r = await alicePage.evaluate(async (uid) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const resp = await fetch('/api/chat/dm-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ target_user_id: uid })
      });
      return { status: resp.status, body: await resp.json() };
    }, uidB);
    if (r.status !== 201) throw new Error(`dm-channels ${r.status}: ${JSON.stringify(r.body)}`);
    const dmId = r.body.id;

    await alicePage.goto(`/app/@me/${dmId}`);
    await expect(alicePage.getByTestId('message-input')).toBeVisible({ timeout: 10_000 });
    await sendDm(alicePage, 'vorlage eins');
    await bobPage.goto(`/app/@me/${dmId}`);
    await expect(bobPage.getByTestId('message-input')).toBeVisible({ timeout: 10_000 });
    await expect(
      bobPage.locator('[data-testid="message-content"]', { hasText: 'vorlage eins' })
    ).toBeVisible({ timeout: 10_000 });
  });

  test('bob meldet sich ab und wieder an', async () => {
    await bobPage.getByTestId('user-footer-trigger').click();
    await bobPage.getByTestId('sign-out').click();
    await bobPage.waitForURL(/\/login/);
    await login(bobPage, BOB);
    await bobPage.waitForURL(/\/app/);
  });

  test('danach: alice → bob kommt an', async () => {
    const url = new URL(alicePage.url()).pathname;
    await sendDm(alicePage, 'nach relogin von alice');
    await expect(
      alicePage.locator('[data-testid="message-content"]', { hasText: 'nach relogin von alice' })
    ).toBeVisible({ timeout: 10_000 });
    await bobPage.goto(url);
    await expect(bobPage.getByTestId('message-input')).toBeVisible({ timeout: 10_000 });
    await expect(
      bobPage.locator('[data-testid="message-content"]', { hasText: 'nach relogin von alice' })
    ).toBeVisible({ timeout: 15_000 });
  });

  test('danach: bob → alice kommt an', async () => {
    await sendDm(bobPage, 'nach relogin von bob');
    await expect(
      alicePage.locator('[data-testid="message-content"]', { hasText: 'nach relogin von bob' })
    ).toBeVisible({ timeout: 15_000 });
  });
});
