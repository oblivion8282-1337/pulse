/**
 * Watch-Party E2E.
 *
 * Coverage:
 *   - Frontend `parseSource` mirror accepts/rejects URLs as expected (including
 *     Twitch live channels added in T+).
 *   - The WS `watch_start` op produces server-side state visible to both
 *     clients via the REST re-sync endpoint.
 *   - Host vs viewer enforcement: only the host can stop, non-host gets
 *     `4015`; second `watch_start` on the same channel gets `4014`.
 *
 * What we do NOT verify here:
 *   - The WatchPartyStartButton + dialog UI — they live in the VoiceControlBar
 *     which only renders after LiveKit voice join, and the E2E harness doesn't
 *     bring up LiveKit. The WS + REST coverage below exercises the same
 *     server-side codepath the button triggers.
 *   - The WatchPartyTile itself — same LiveKit dependency.
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

/** Open a WS, skip the initial `ready`, send one op, wait for the first
 * non-ready response, close. Used to exercise watch_start/stop/etc. without
 * the UI button (which sits in the VoiceControlBar and isn't mounted in the
 * E2E harness — no LiveKit). The server enforces the same membership /
 * authorisation checks regardless of caller. */
async function wsCall(
  page: Page,
  payload: object,
  timeoutMs = 5000
): Promise<{ op: string; [k: string]: unknown }> {
  return page.evaluate(
    ({ payload, timeoutMs }) =>
      new Promise((resolve, reject) => {
        const token = localStorage.getItem('dcc.tokens.access');
        if (!token) return reject(new Error('no access token in localStorage'));
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        // Vite proxies /api/ws → ws://127.0.0.1:8002, stripping the /api/ws
        // prefix. Backend mounts @router.websocket("/ws"). Net path = /api/ws/ws.
        // Same shape as `wsPath` in $lib/ws/connection.ts:140.
        const ws = new WebSocket(
          `${proto}://${location.host}/api/ws/ws?token=${encodeURIComponent(token)}`
        );
        const t = setTimeout(() => {
          ws.close();
          reject(new Error('ws call timed out'));
        }, timeoutMs);
        let sent = false;
        ws.onopen = () => {
          if (sent) return;
          sent = true;
          ws.send(JSON.stringify(payload));
        };
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          // `ready` always lands first; presence/voice broadcasts are noise.
          if (m.op === 'ready' || m.op === 'presence_update' || m.op === 'voice_state')
            return;
          clearTimeout(t);
          ws.close();
          resolve(m);
        };
        ws.onerror = () => {
          clearTimeout(t);
          reject(new Error('ws error'));
        };
      }),
    { payload, timeoutMs }
  );
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

  test('parseSource mirror accepts/rejects URLs (YT, Twitch VOD+Live, native)', async () => {
    // The frontend's parseSource is what the dialog uses for live UI feedback;
    // the backend has its own copy that re-validates server-side. Both must
    // agree — we test the frontend here, the backend in pytest. Run inside
    // the page so the real module is exercised.
    const out = await alicePage.evaluate(async () => {
      // The module is bundled into the SPA; import via its public alias.
      const mod = await import('/src/lib/watch/source.ts');
      const { parseSource } = mod as { parseSource: (u: string) => unknown };
      return {
        ytWatch: parseSource('https://www.youtube.com/watch?v=abc12345678'),
        ytShort: parseSource('https://youtu.be/abc12345678'),
        twitchVod: parseSource('https://www.twitch.tv/videos/1234567890'),
        twitchLive: parseSource('https://www.twitch.tv/xqc'),
        twitchReserved: parseSource('https://www.twitch.tv/directory'),
        garbage: parseSource('not a url'),
        httpOnly: parseSource('http://example.com/movie.mp4')
      };
    });
    expect(out.ytWatch).toMatchObject({ type: 'youtube', embed_id: 'abc12345678' });
    expect(out.ytShort).toMatchObject({ type: 'youtube', embed_id: 'abc12345678' });
    expect(out.twitchVod).toMatchObject({ type: 'twitch', embed_id: '1234567890' });
    expect(out.twitchLive).toMatchObject({ type: 'twitch_live', channel: 'xqc' });
    expect(out.twitchReserved).toBeNull();
    expect(out.garbage).toBeNull();
    expect(out.httpOnly).toBeNull();
  });

  test('watch_start via WS produces a party visible to both via REST', async () => {
    const resp = await wsCall(alicePage, {
      op: 'watch_start',
      channel_id: voiceChannelId,
      source_url: 'https://www.youtube.com/watch?v=abc12345678'
    });
    expect(resp.op).toBe('watch_state');

    const matchPartyShape = (states: Awaited<ReturnType<typeof getGuildWatchState>>) => {
      const e = states.find((s) => s.channel_id === voiceChannelId);
      expect(e, 'watch-state entry for the voice channel').toBeDefined();
      expect(e!.state).not.toBeNull();
      expect(e!.state!.host_user_id).toBe(aliceUserId);
      expect(e!.state!.source).toMatchObject({ type: 'youtube', embed_id: 'abc12345678' });
    };
    matchPartyShape(await getGuildWatchState(alicePage, guildId));
    matchPartyShape(await getGuildWatchState(bobPage, guildId));
  });

  test('only host can stop; second start gets 4014', async () => {
    // Bob (non-host) tries to stop — server replies 4015.
    const bobStop = await wsCall(bobPage, {
      op: 'watch_stop',
      channel_id: voiceChannelId
    });
    expect(bobStop).toMatchObject({ op: 'error', code: 4015 });

    // Bob (or anyone else) tries to start a second party — 4014.
    const bobStart = await wsCall(bobPage, {
      op: 'watch_start',
      channel_id: voiceChannelId,
      source_url: 'https://youtu.be/xyz12345678'
    });
    expect(bobStart).toMatchObject({ op: 'error', code: 4014 });

    // Alice (host) stops cleanly. Server broadcasts state=null.
    const aliceStop = await wsCall(alicePage, {
      op: 'watch_stop',
      channel_id: voiceChannelId
    });
    expect(aliceStop.op).toBe('watch_state');
    expect((aliceStop as { state: unknown }).state).toBeNull();

    // REST re-sync now shows no party for either user.
    expect(
      (await getGuildWatchState(alicePage, guildId)).find((s) => s.channel_id === voiceChannelId)
    ).toBeUndefined();
  });
});
