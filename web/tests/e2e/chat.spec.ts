import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const ts = Date.now();
const ALICE = {
  username: `alice_${ts}`,
  email: `alice_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const BOB = {
  username: `bob_${ts}`,
  email: `bob_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};

async function register(page: Page, u: { username: string; email: string; password: string }) {
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

async function login(page: Page, identifier: string, password: string) {
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill(identifier);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
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

async function addBobToGuild(alicePage: Page, guildId: string, bobUserId: string) {
  const response = await alicePage.evaluate(
    async ([gid, uid]) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const r = await fetch(`/api/chat/guilds/${gid}/members`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        // Pass the user_id as a *string* — snowflake IDs exceed 2^53 and
        // Number() would silently drop the lowest bits.
        body: JSON.stringify({ user_id: uid })
      });
      return { status: r.status, body: await r.text() };
    },
    [guildId, bobUserId]
  );
  if (response.status !== 201 && response.status !== 200) {
    throw new Error(`addBobToGuild failed ${response.status}: ${response.body}`);
  }
}

test.describe.serial('Discord-Clone E2E', () => {
  let aliceCtx: BrowserContext;
  let alicePage: Page;
  let bobCtx: BrowserContext;
  let bobPage: Page;
  let guildId = '';
  let channelId = '';
  let bobUserId = '';

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

  test('registers both users', async () => {
    await register(alicePage, ALICE);
    await register(bobPage, BOB);

    bobUserId = await currentUserId(bobPage);
    expect(bobUserId).toMatch(/^\d+$/);
  });

  test('Alice creates a guild and a channel', async () => {
    // Empty state shows "create guild" button.
    await expect(alicePage.getByTestId('empty-create-guild')).toBeVisible();
    await alicePage.getByTestId('empty-create-guild').click();
    await alicePage.getByTestId('create-guild-choice').click();
    await alicePage.getByTestId('create-guild-name').fill('Night Team');
    await alicePage.getByTestId('create-guild-submit').click();

    // The app navigates straight to the auto-created "general" channel.
    await alicePage.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/);
    const url = new URL(alicePage.url());
    const parts = url.pathname.split('/');
    guildId = parts[3];
    channelId = parts[5];
    expect(guildId).toMatch(/^\d+$/);
    expect(channelId).toMatch(/^\d+$/);

    await expect(alicePage.getByTestId('active-channel-name')).toHaveText('general');
  });

  test('Bob joins the guild and sees the channel', async () => {
    await addBobToGuild(alicePage, guildId, bobUserId);
    await bobPage.goto(`/app/guilds/${guildId}/channels/${channelId}`);
    await bobPage.reload();
    await expect(bobPage.getByTestId('app-shell')).toBeVisible();
    await expect(bobPage.getByTestId('active-channel-name')).toHaveText('general', {
      timeout: 15_000
    });
  });

  test('Alice sends a message; Bob sees it real-time', async () => {
    await alicePage.getByTestId('message-input').click();
    await alicePage.getByTestId('message-input').fill('hello from alice');
    await alicePage.getByTestId('message-input').press('Enter');

    // Wait for Bob to receive the message over the WS.
    await expect(bobPage.locator('[data-testid="message-content"]', { hasText: 'hello from alice' })).toBeVisible({
      timeout: 5_000
    });
    // Alice sees her own message too.
    await expect(
      alicePage.locator('[data-testid="message-content"]', { hasText: 'hello from alice' })
    ).toBeVisible();
  });

  test('Bob replies; Alice sees it', async () => {
    await bobPage.getByTestId('message-input').click();
    await bobPage.getByTestId('message-input').fill('hey alice o/');
    await bobPage.getByTestId('message-input').press('Enter');

    await expect(
      alicePage.locator('[data-testid="message-content"]', { hasText: 'hey alice o/' })
    ).toBeVisible({ timeout: 5_000 });
  });

  test('history survives reload', async () => {
    await alicePage.reload();
    await alicePage.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/);
    await expect(
      alicePage.locator('[data-testid="message-content"]', { hasText: 'hello from alice' })
    ).toBeVisible();
    await expect(
      alicePage.locator('[data-testid="message-content"]', { hasText: 'hey alice o/' })
    ).toBeVisible();
  });

  test('Bob can post + receive an echo through the WS', async () => {
    await bobPage.getByTestId('message-input').click();
    await bobPage.getByTestId('message-input').fill('still here');
    await bobPage.getByTestId('message-input').press('Enter');
    await expect(
      bobPage.locator('[data-testid="message-content"]', { hasText: 'still here' })
    ).toBeVisible();
  });

  test('Alice @-mentions Bob; Bob sees a mention pill on the channel', async () => {
    // Park Bob on a second channel in the same guild so the mention badge
    // for the *first* channel has somewhere to render (ChannelList only
    // mounts on /app/guilds/<gid>/channels/<cid>, and being active on the
    // mentioned channel would mark-read immediately).
    const offTopicId = await alicePage.evaluate(
      async ({ guildId }) => {
        const token = localStorage.getItem('dcc.tokens.access');
        const res = await fetch(`/api/chat/guilds/${guildId}/channels`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ name: 'off-topic', type: 0 })
        });
        return (await res.json()).id as string;
      },
      { guildId }
    );
    await bobPage.goto(`/app/guilds/${guildId}/channels/${offTopicId}`);
    await bobPage.waitForURL(new RegExp(`/app/guilds/${guildId}/channels/${offTopicId}`));
    await expect(bobPage.getByTestId(`channel-${channelId}`)).toBeVisible();

    await alicePage.getByTestId('message-input').click();
    await alicePage.getByTestId('message-input').fill(`<@${bobUserId}> ping`);
    await alicePage.getByTestId('message-input').press('Enter');

    // The pill is rendered next to the channel name in Bob's channel list.
    // We give it a generous window because the WS hop + counter persist take
    // a moment after navigation.
    const pill = bobPage.locator(`[data-testid="channel-${channelId}"] [data-testid="channel-mention-pill"]`);
    await expect(pill).toBeVisible({ timeout: 10_000 });
    await expect(pill).toHaveText(/\d+/);
  });
});
