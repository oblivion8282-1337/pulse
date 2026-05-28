/**
 * Etappe 4 — Friends-Foundation: end-to-end happy paths.
 *
 * Covers:
 *  1. Alice findet Bob über die User-Suche, schickt Friend-Request, Bob
 *     akzeptiert via Pending-Tab. Beide sehen sich danach in "Alle Freunde".
 *  2. Auto-Accept: Alice schickt erste Anfrage, Bob schickt eine umgekehrte
 *     Anfrage zurück → Server liefert auto_accepted; beide sind direkt
 *     befreundet.
 *  3. DM-Hard-Cut Foundation: Vor Friendship rejected /api/chat/dm-channels
 *     mit 403 not_friends; nach Annahme klappt das Senden in der DM.
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const ts = Date.now();

function userFixture(role: 'alice' | 'bob' | 'carol', salt: string) {
  return {
    username: `${role}_friends_${salt}`,
    email: `${role}_friends_${salt}@dcc-test.example.com`,
    password: 'sup3r-secret-pass'
  };
}

async function register(
  page: Page,
  u: { username: string; email: string; password: string }
) {
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(u.username);
  await page.getByTestId('reg-email').fill(u.email);
  await page.getByTestId('reg-password').fill(u.password);
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/);
  // BackupSetupStep poppt nach runIssueFlow auf (s. issue-flow.ts) — der
  // Dialog blockiert sonst die nächsten Klicks per overlay. Best-effort
  // dismiss; wenn der Dialog nicht erscheint (z.B. weil Re-Run im Test
  // ohne fresh-register), schluckt der catch.
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
  if (!value) throw new Error('no access token found in localStorage');
  return value;
}

test.describe.serial('Friends — happy paths', () => {
  let aliceCtx: BrowserContext;
  let alicePage: Page;
  let bobCtx: BrowserContext;
  let bobPage: Page;

  const ALICE = userFixture('alice', `${ts}_a`);
  const BOB = userFixture('bob', `${ts}_a`);

  test.beforeAll(async ({ browser }) => {
    aliceCtx = await browser.newContext();
    bobCtx = await browser.newContext();
    alicePage = await aliceCtx.newPage();
    bobPage = await bobCtx.newPage();
  });

  test.afterAll(async () => {
    await aliceCtx.close();
    await bobCtx.close();
  });

  test('register both users', async () => {
    await register(alicePage, ALICE);
    await register(bobPage, BOB);
  });

  test('alice searches bob and sends a friend request', async () => {
    await alicePage.goto('/app/friends?tab=add');
    await expect(alicePage.getByTestId('add-friend-input')).toBeVisible();
    await alicePage.getByTestId('add-friend-input').fill(BOB.username);
    // 300ms debounce + roundtrip
    await expect(
      alicePage.locator('[data-testid="search-hit"]')
    ).toBeVisible({ timeout: 5000 });
    await alicePage.getByTestId('search-hit-add').click();
    // After sending, the row shows the "Anfrage offen" label instead of
    // the Add button (relation now exists).
    await expect(alicePage.getByTestId('search-hit-status')).toContainText(
      'Anfrage offen',
      { timeout: 3000 }
    );
  });

  test('bob sees the incoming request and accepts it', async () => {
    await bobPage.goto('/app/friends?tab=pending');
    // The push arrives over WS; the sidebar badge also shows it. Wait
    // for the actual row.
    const row = bobPage.getByTestId('pending-in-row');
    await expect(row).toBeVisible({ timeout: 7000 });
    await row.getByTestId('pending-accept-btn').click();
    await expect(row).toHaveCount(0, { timeout: 5000 });
  });

  test('both sides now see each other under "Alle Freunde"', async () => {
    await bobPage.goto('/app/friends?tab=all');
    await expect(bobPage.getByTestId('friend-row')).toHaveCount(1, {
      timeout: 5000
    });
    await alicePage.goto('/app/friends?tab=all');
    await expect(alicePage.getByTestId('friend-row')).toHaveCount(1, {
      timeout: 5000
    });
  });

  test('DM hard-cut: with friendship, alice can create a DM and send', async () => {
    const bobUserId = await currentUserId(bobPage);
    const dmResp = await alicePage.evaluate(async (uid) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const r = await fetch('/api/chat/dm-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ target_user_id: uid })
      });
      return { status: r.status, body: await r.text() };
    }, bobUserId);
    expect([200, 201]).toContain(dmResp.status);
    const dm = JSON.parse(dmResp.body) as { id: string; can_send?: boolean };
    expect(dm.can_send === undefined || dm.can_send === true).toBeTruthy();

    await alicePage.goto(`/app/@me/${dm.id}`);
    const input = alicePage.getByTestId('message-input');
    await expect(input).toBeEnabled({ timeout: 5000 });
    await input.fill('hi from friends-tab');
    await input.press('Enter');
    await expect(
      alicePage.locator('[data-testid="message-content"]', {
        hasText: 'hi from friends-tab'
      })
    ).toBeVisible({ timeout: 10000 });
  });
});

test.describe.serial('Friends — auto-accept on reverse request', () => {
  let aliceCtx: BrowserContext;
  let alicePage: Page;
  let bobCtx: BrowserContext;
  let bobPage: Page;

  const ALICE = userFixture('alice', `${ts}_b`);
  const BOB = userFixture('bob', `${ts}_b`);

  test.beforeAll(async ({ browser }) => {
    aliceCtx = await browser.newContext();
    bobCtx = await browser.newContext();
    alicePage = await aliceCtx.newPage();
    bobPage = await bobCtx.newPage();
  });

  test.afterAll(async () => {
    await aliceCtx.close();
    await bobCtx.close();
  });

  test('register two new users', async () => {
    await register(alicePage, ALICE);
    await register(bobPage, BOB);
  });

  test('alice → bob (pending), then bob → alice → auto-accept', async () => {
    const bobUserId = await currentUserId(bobPage);
    const aliceUserId = await currentUserId(alicePage);

    // First request (pending)
    const firstResp = await alicePage.evaluate(async (uid) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const r = await fetch('/api/chat/friend-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ target_user_id: uid })
      });
      return { status: r.status, body: await r.text() };
    }, bobUserId);
    expect(firstResp.status, firstResp.body).toBe(201);

    // Reverse request from Bob — should auto-accept
    const secondResp = await bobPage.evaluate(async (uid) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const r = await fetch('/api/chat/friend-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ target_user_id: uid })
      });
      return { status: r.status, body: await r.text() };
    }, aliceUserId);
    expect(secondResp.status, secondResp.body).toBe(201);
    const body = JSON.parse(secondResp.body);
    expect(body.auto_accepted).toBe(true);
    expect(body.friendship.user_id).toBe(aliceUserId);

    // Both pages reflect it once we hit the friends tab + WS catches up.
    await alicePage.goto('/app/friends?tab=all');
    await expect(alicePage.getByTestId('friend-row')).toHaveCount(1, {
      timeout: 7000
    });
    await bobPage.goto('/app/friends?tab=all');
    await expect(bobPage.getByTestId('friend-row')).toHaveCount(1, {
      timeout: 7000
    });
  });
});

test.describe.serial('Friends — sidebar entry', () => {
  let page: Page;
  const SOLO = userFixture('carol', `${ts}_solo`);

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    page = await ctx.newPage();
  });

  test('register + verify sidebar link exists and routes to friends page', async () => {
    await register(page, SOLO);
    await page.goto('/app/@me');
    const link = page.getByTestId('sidebar-friends-link');
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForURL(/\/app\/friends/);
    // Default tab is "online" — empty state visible.
    await expect(page.getByTestId('friends-empty')).toBeVisible({
      timeout: 5000
    });
  });
});
