import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const ts = Date.now();
const ALICE = {
  username: `alice_dm_${ts}`,
  email: `alice_dm_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const BOB = {
  username: `bob_dm_${ts}`,
  email: `bob_dm_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};

async function register(page: Page, u: { username: string; email: string; password: string }) {
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(u.username);
  await page.getByTestId('reg-email').fill(u.email);
  await page.getByTestId('reg-password').fill(u.password);
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/);
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

async function addMemberToGuild(adminPage: Page, guildId: string, userId: string) {
  const response = await adminPage.evaluate(
    async ([gid, uid]) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const r = await fetch(`/api/chat/guilds/${gid}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ user_id: uid })
      });
      return { status: r.status, body: await r.text() };
    },
    [guildId, userId]
  );
  if (response.status !== 201 && response.status !== 200) {
    throw new Error(`addMember failed ${response.status}: ${response.body}`);
  }
}

/** Establish a mutual friendship between the two users by sending cross
 *  friend-requests — the second POST auto-accepts in a single TX. DMs are
 *  friend-gated since Phase 2 (``not_friends`` → 403), so this is required
 *  before ``POST /dm-channels`` succeeds. Pattern mirrored from
 *  ``friends.spec.ts``. */
async function becomeFriends(
  pageA: Page,
  uidA: string,
  pageB: Page,
  uidB: string
): Promise<void> {
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
    if (r.status !== 201) {
      throw new Error(`friend-request failed ${r.status}: ${r.body}`);
    }
  };
  await send(pageA, uidB);
  await send(pageB, uidA); // reverse → auto-accept
}

test.describe.serial('DM (direct messages) E2E', () => {
  let aliceCtx: BrowserContext;
  let alicePage: Page;
  let bobCtx: BrowserContext;
  let bobPage: Page;
  let guildId = '';
  let channelId = '';
  let bobUserId = '';
  let dmUrlPath = '';

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

  test('register both users, alice creates guild, bob joins', async () => {
    await register(alicePage, ALICE);
    await register(bobPage, BOB);
    bobUserId = await currentUserId(bobPage);
    const aliceUserId = await currentUserId(alicePage);

    // ``POST /dm-channels`` is friend-gated since the Phase-2 friends
    // rollout — without a friendship it returns 403 ``not_friends`` and
    // the right-click DM flow below fails before navigation. Establish
    // the friendship now so the rest of the suite has a working DM.
    await becomeFriends(alicePage, aliceUserId, bobPage, bobUserId);

    await expect(alicePage.getByTestId('empty-create-guild')).toBeVisible();
    await alicePage.getByTestId('empty-create-guild').click();
    await alicePage.getByTestId('create-guild-choice').click();
    await alicePage.getByTestId('create-guild-name').fill('DM Crew');
    await alicePage.getByTestId('create-guild-submit').click();

    await alicePage.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/);
    const url = new URL(alicePage.url());
    const parts = url.pathname.split('/');
    guildId = parts[3];
    channelId = parts[5];

    await addMemberToGuild(alicePage, guildId, bobUserId);
    await bobPage.goto(`/app/guilds/${guildId}/channels/${channelId}`);
    await expect(bobPage.getByTestId('active-channel-name')).toHaveText('general', {
      timeout: 15_000
    });
  });

  test('alice opens a DM with bob from the member-list context menu', async () => {
    // The member list is hidden behind the header toggle by default
    // (memberListOpen=false). Click it before looking for the row.
    await alicePage.getByTestId('member-list-toggle').click();
    const bobRow = alicePage
      .getByTestId('member-item')
      .and(alicePage.locator(`[data-user-id="${bobUserId}"]`));
    await expect(bobRow).toBeVisible({ timeout: 10_000 });

    // Right-click to summon the per-row context menu, then "Nachricht senden".
    await bobRow.click({ button: 'right' });
    await alicePage.getByTestId('member-dm-menu').click();

    await alicePage.waitForURL(/\/app\/@me\/\d+/, { timeout: 10_000 });
    dmUrlPath = new URL(alicePage.url()).pathname;
    // ChatView header should switch to DM mode — name = bob's username.
    await expect(alicePage.getByTestId('active-channel-name')).toHaveText(BOB.username, {
      timeout: 10_000
    });
  });

  test('alice sends a DM, bob sees it appear in his sidebar', async () => {
    await alicePage.getByTestId('message-input').click();
    await alicePage.getByTestId('message-input').fill('hi bob, private hello');
    await alicePage.getByTestId('message-input').press('Enter');

    // Bob is still on the guild channel. The dm_bump fires globally — his DM
    // store should pick it up. We don't have a header indicator for unread
    // DMs yet, so just navigate to /app/@me and verify the DM is listed.
    await bobPage.goto('/app/@me');
    await expect(bobPage.getByTestId('dm-channel-list')).toBeVisible();
    // The DM tile should be there (matched by alice's name OR by url after click).
    const dmTile = bobPage
      .getByTestId('dm-channel-list')
      .getByRole('button', { name: ALICE.username });
    await expect(dmTile).toBeVisible({ timeout: 10_000 });
  });

  test('bob opens the DM and sees the message', async () => {
    await bobPage
      .getByTestId('dm-channel-list')
      .getByRole('button', { name: ALICE.username })
      .click();
    await bobPage.waitForURL(/\/app\/@me\/\d+/);
    await expect(
      bobPage.locator('[data-testid="message-content"]', { hasText: 'hi bob, private hello' })
    ).toBeVisible({ timeout: 10_000 });
  });

  test('bob replies, alice sees it real-time', async () => {
    await bobPage.getByTestId('message-input').click();
    await bobPage.getByTestId('message-input').fill('yo alice');
    await bobPage.getByTestId('message-input').press('Enter');
    await expect(
      alicePage.locator('[data-testid="message-content"]', { hasText: 'yo alice' })
    ).toBeVisible({ timeout: 10_000 });
  });

  test('history survives a reload on the DM route', async () => {
    await alicePage.reload();
    await alicePage.waitForURL(new RegExp(dmUrlPath.replace(/\//g, '\\/')));
    await expect(
      alicePage.locator('[data-testid="message-content"]', { hasText: 'hi bob, private hello' })
    ).toBeVisible();
    await expect(
      alicePage.locator('[data-testid="message-content"]', { hasText: 'yo alice' })
    ).toBeVisible();
  });

  test('reopening the DM from alice is idempotent (same channel id)', async () => {
    // Go back to the guild channel, then re-trigger the DM-open flow. Should
    // resolve to the same /app/@me/<id> URL.
    await alicePage.goto(`/app/guilds/${guildId}/channels/${channelId}`);
    await alicePage.getByTestId('member-list-toggle').click();
    const bobRow = alicePage
      .getByTestId('member-item')
      .and(alicePage.locator(`[data-user-id="${bobUserId}"]`));
    await bobRow.click({ button: 'right' });
    await alicePage.getByTestId('member-dm-menu').click();
    await alicePage.waitForURL(new RegExp(dmUrlPath.replace(/\//g, '\\/')));
  });
});
