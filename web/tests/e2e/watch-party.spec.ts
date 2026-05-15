/**
 * Watch-Party E2E.
 *
 * Coverage:
 *   - WatchPartyStartButton renders in the voice-channel header (both clients).
 *   - URL popover live-validates via the frontend `parseSource` mirror.
 *   - Clicking Start triggers the WS `watch_start` op; both clients see the
 *     server-side state via the REST re-sync endpoint.
 *   - With a party active, the start button is disabled for everyone (the
 *     "one party per channel" invariant — backend enforces 4014 anyway, but
 *     the UI shouldn't let the user even open the popover).
 *
 * What we do NOT verify here (deferred to manual / unit tests):
 *   - The WatchPartyTile itself — it only renders after LiveKit voice join,
 *     which the E2E harness doesn't bring up.
 *   - Drift correction across browsers — covered by sync.ts logic + manual.
 *   - YouTube/Twitch iframes — third-party scripts, flaky in headless CI.
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const ts = Date.now();
const ALICE = {
  username: `wpalice_${ts}`,
  email: `wpalice_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const BOB = {
  username: `wpbob_${ts}`,
  email: `wpbob_${ts}@dcc-test.example.com`,
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

/** Add a user to a guild via the chat-gateway REST API. */
async function addMember(page: Page, guildId: string, userId: string) {
  const r = await page.evaluate(
    async ([gid, uid]) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const res = await fetch(`/api/chat/guilds/${gid}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ user_id: uid })
      });
      return { status: res.status, body: await res.text() };
    },
    [guildId, userId]
  );
  if (r.status !== 201 && r.status !== 200) {
    throw new Error(`addMember ${r.status}: ${r.body}`);
  }
}

/** Create a channel via REST. type=1 is voice. */
async function createChannel(
  page: Page,
  guildId: string,
  name: string,
  type: number
): Promise<string> {
  const r = await page.evaluate(
    async ([gid, n, t]) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const res = await fetch(`/api/chat/guilds/${gid}/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: n, type: t })
      });
      return { status: res.status, body: await res.text() };
    },
    [guildId, name, type] as [string, string, number]
  );
  if (r.status !== 201 && r.status !== 200) {
    throw new Error(`createChannel ${r.status}: ${r.body}`);
  }
  return JSON.parse(r.body).id as string;
}

/** REST re-sync helper — same shape as ready.watch_states. */
async function getGuildWatchState(page: Page, guildId: string): Promise<
  { channel_id: string; state: { host_user_id: string; source: { type: string; embed_id?: string; url?: string } } | null }[]
> {
  const r = await page.evaluate(async (gid) => {
    const token = localStorage.getItem('dcc.tokens.access');
    const res = await fetch(`/api/chat/guilds/${gid}/watch-state`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return res.json();
  }, guildId);
  return r.watch_states ?? [];
}

test.describe.serial('Watch Party E2E', () => {
  let aliceCtx: BrowserContext;
  let alicePage: Page;
  let bobCtx: BrowserContext;
  let bobPage: Page;
  let guildId = '';
  let voiceChannelId = '';
  let aliceUserId = '';
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

  test('register both users', async () => {
    await register(alicePage, ALICE);
    await register(bobPage, BOB);
    aliceUserId = await currentUserId(alicePage);
    bobUserId = await currentUserId(bobPage);
  });

  test('alice creates guild + voice channel; bob joins', async () => {
    await expect(alicePage.getByTestId('empty-create-guild')).toBeVisible();
    await alicePage.getByTestId('empty-create-guild').click();
    await alicePage.getByTestId('create-guild-choice').click();
    await alicePage.getByTestId('create-guild-name').fill('Watch Party Test');
    await alicePage.getByTestId('create-guild-submit').click();
    await alicePage.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/);
    guildId = new URL(alicePage.url()).pathname.split('/')[3];

    // Add a voice channel and add Bob — both via REST so the test stays focused
    // on the watch-party UI itself.
    voiceChannelId = await createChannel(alicePage, guildId, 'Voice', 1);
    await addMember(alicePage, guildId, bobUserId);

    // Both navigate to the voice channel.
    await alicePage.goto(`/app/guilds/${guildId}/channels/${voiceChannelId}`);
    await bobPage.goto(`/app/guilds/${guildId}/channels/${voiceChannelId}`);
    await expect(alicePage.getByTestId('voice-channel-view')).toBeVisible();
    await expect(bobPage.getByTestId('voice-channel-view')).toBeVisible();
  });

  test('start-button visible for both members; popover validates URL', async () => {
    await expect(alicePage.getByTestId('watch-party-start-button')).toBeEnabled();
    await expect(bobPage.getByTestId('watch-party-start-button')).toBeEnabled();

    // Alice opens the popover and tries garbage, then a valid URL.
    await alicePage.getByTestId('watch-party-start-button').click();
    await expect(alicePage.getByTestId('watch-party-popover')).toBeVisible();

    const input = alicePage.getByTestId('watch-party-url-input');
    await input.fill('not a url');
    await expect(alicePage.getByTestId('watch-party-parse-error')).toBeVisible();

    await input.fill('https://www.youtube.com/watch?v=abc12345678');
    await expect(alicePage.getByTestId('watch-party-parse-ok')).toHaveText('YouTube');
  });

  test('start broadcasts the party; REST sees it for both users', async () => {
    // Alice confirms the start. Popover closes.
    await alicePage.getByTestId('watch-party-start-confirm').click();
    await expect(alicePage.getByTestId('watch-party-popover')).toHaveCount(0);

    // The REST re-sync (read straight off Redis) shows Alice's party in the
    // voice channel — for both users, since membership is the only gate.
    const matchPartyShape = (states: Awaited<ReturnType<typeof getGuildWatchState>>) => {
      const e = states.find((s) => s.channel_id === voiceChannelId);
      expect(e, 'watch-state entry for the voice channel').toBeDefined();
      expect(e!.state).not.toBeNull();
      expect(e!.state!.host_user_id).toBe(aliceUserId);
      expect(e!.state!.source).toMatchObject({ type: 'youtube', embed_id: 'abc12345678' });
    };

    // Brief retry — the WS push lands within ~100ms but is async wrt our REST
    // call. The REST endpoint reads Redis directly, so it's always at least
    // as fresh as the WS push (the WS push happens *after* the SET).
    await expect
      .poll(async () => (await getGuildWatchState(alicePage, guildId)).length, { timeout: 3000 })
      .toBeGreaterThan(0);
    matchPartyShape(await getGuildWatchState(alicePage, guildId));
    matchPartyShape(await getGuildWatchState(bobPage, guildId));
  });

  test('start button is disabled while a party is active (both clients)', async () => {
    // Frontend store should reflect the WS push that landed on each client.
    // Both buttons go to disabled state.
    await expect(alicePage.getByTestId('watch-party-start-button')).toBeDisabled();
    await expect(bobPage.getByTestId('watch-party-start-button')).toBeDisabled();
  });
});
