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
          // `hello` (Phase 3) + `ready` always land first; presence/voice
          // broadcasts are noise.
          if (
            m.op === 'hello' ||
            m.op === 'ready' ||
            m.op === 'presence_update' ||
            m.op === 'voice_state' ||
            m.op === 'watch_watchers'
          )
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

/**
 * Persistent-WS helpers. Unlike `wsCall` (open → send → close), these keep a
 * socket open across evaluate() calls by stashing it on `window.__wp[label]`,
 * with a message log. Needed because host-handoff cleanup now ends a solo
 * party the instant the host's only socket closes — so the host must stay
 * connected while we drive joins / handoffs / disconnects.
 */
async function wsOpen(page: Page, label: string, timeoutMs = 5000): Promise<void> {
  await page.evaluate(
    ({ label, timeoutMs }) =>
      new Promise<void>((resolve, reject) => {
        const token = localStorage.getItem('dcc.tokens.access');
        if (!token) return reject(new Error('no access token in localStorage'));
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(
          `${proto}://${location.host}/api/ws/ws?token=${encodeURIComponent(token)}`
        );
        const store = ((window as unknown as { __wp: Record<string, unknown> }).__wp ??= {});
        store[label] = { ws, log: [] as unknown[] };
        const t = setTimeout(() => reject(new Error('ws open timed out')), timeoutMs);
        ws.onmessage = (e) => {
          (store[label] as { log: unknown[] }).log.push(JSON.parse(e.data));
        };
        ws.onopen = () => {
          clearTimeout(t);
          resolve();
        };
        ws.onerror = () => {
          clearTimeout(t);
          reject(new Error('ws error'));
        };
      }),
    { label, timeoutMs }
  );
}

async function wsSend(page: Page, label: string, payload: object): Promise<void> {
  await page.evaluate(
    ({ label, payload }) => {
      const h = (window as unknown as { __wp: Record<string, { ws: WebSocket }> }).__wp[label];
      h.ws.send(JSON.stringify(payload));
    },
    { label, payload }
  );
}

/** Resolve once a frame matching `opName` (and optional substring in JSON)
 * lands in the persistent socket's log. */
async function wsWaitFor(
  page: Page,
  label: string,
  opName: string,
  contains = '',
  timeoutMs = 5000
): Promise<Record<string, unknown>> {
  return page.evaluate(
    ({ label, opName, contains, timeoutMs }) =>
      new Promise((resolve, reject) => {
        const h = (window as unknown as { __wp: Record<string, { log: Record<string, unknown>[] }> })
          .__wp[label];
        const deadline = Date.now() + timeoutMs;
        const check = () => {
          const hit = h.log.find(
            (m) => m.op === opName && (!contains || JSON.stringify(m).includes(contains))
          );
          if (hit) return resolve(hit);
          if (Date.now() > deadline) return reject(new Error(`wsWaitFor ${opName} timed out`));
          setTimeout(check, 50);
        };
        check();
      }),
    { label, opName, contains, timeoutMs }
  );
}

async function wsClose(page: Page, label: string): Promise<void> {
  await page.evaluate((label) => {
    const store = (window as unknown as { __wp?: Record<string, { ws: WebSocket }> }).__wp;
    store?.[label]?.ws.close();
  }, label);
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
    // the page so the real module is exercised. The path is a Vite-dev URL
    // resolved at browser runtime, not a TS module path — TS can't see it.
    const out = await alicePage.evaluate(async () => {
      // @ts-expect-error - Vite-served path resolved at browser runtime
      const mod = (await import('/src/lib/watch/source.ts')) as {
        parseSource: (u: string) => unknown;
      };
      const { parseSource } = mod;
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

  test('watch_start via persistent host socket is visible to both via REST', async () => {
    // Host must stay connected: disconnect cleanup now ends a solo party the
    // instant the host's last socket closes. wsOpen keeps Alice's socket open.
    await wsOpen(alicePage, 'host');
    await wsSend(alicePage, 'host', {
      op: 'watch_start',
      channel_id: voiceChannelId,
      source_url: 'https://www.youtube.com/watch?v=abc12345678'
    });
    await wsWaitFor(alicePage, 'host', 'watch_state');

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
    // The party is held open by Alice's persistent 'host' socket. Bob's
    // single-shot wsCall sockets never join the watcher set, so closing them
    // does not disturb the party.
    const bobStop = await wsCall(bobPage, { op: 'watch_stop', channel_id: voiceChannelId });
    expect(bobStop).toMatchObject({ op: 'error', code: 4015 });

    const bobStart = await wsCall(bobPage, {
      op: 'watch_start',
      channel_id: voiceChannelId,
      source_url: 'https://youtu.be/xyz12345678'
    });
    expect(bobStart).toMatchObject({ op: 'error', code: 4014 });
  });

  test('explicit watch_handoff transfers host to a chosen watcher', async () => {
    // Bob opens a persistent socket and joins the watcher set.
    await wsOpen(bobPage, 'watch');
    await wsSend(bobPage, 'watch', { op: 'watch_join', channel_id: voiceChannelId });
    await wsWaitFor(bobPage, 'watch', 'watch_watchers', bobUserId);

    // Alice (host) hands off to Bob.
    await wsSend(alicePage, 'host', {
      op: 'watch_handoff',
      channel_id: voiceChannelId,
      target_user_id: bobUserId
    });
    await expect
      .poll(async () => {
        const s = (await getGuildWatchState(alicePage, guildId)).find(
          (e) => e.channel_id === voiceChannelId
        );
        return s?.state?.host_user_id;
      })
      .toBe(bobUserId);
  });

  test('host disconnect ends the party after the grace window (no promotion)', async () => {
    // After the handoff Bob is host (via 'watch'); Alice is still a watcher
    // (via 'host'). Closing Bob's socket starts the grace timer (1s in E2E);
    // with no reconnect the party ENDS — it is NOT promoted to Alice.
    await wsClose(bobPage, 'watch');
    await expect
      .poll(async () =>
        (await getGuildWatchState(alicePage, guildId)).find(
          (e) => e.channel_id === voiceChannelId
        )
      )
      .toBeFalsy();
  });

  test('host reconnect re-announces watch_join → party survives the grace window', async () => {
    // Regression for the "watch party keeps dying on its own" bug: a transparent
    // WS reconnect drops the host's socket → the server starts the grace timer;
    // the mounted tile never re-fires onMount, so unless the GatewayConnection
    // re-emits watch_join on reconnect, the party ends ~grace later. This drives
    // the *real* GatewayConnection (the app's own ws can't be force-dropped from
    // a test, and the tile needs LiveKit the harness lacks) and simulates a
    // reconnect by dropping + re-dialing — exercising the same `open` handler
    // the auto-reconnect path runs.
    //
    // Use a FRESH voice channel: prior tests leave Alice's persistent 'host'
    // socket in the watcher registry, which would keep her "present" across the
    // socket drop and mask the bug (no fully-left → no grace timer). A new
    // channel guarantees the test socket is the only watcher.
    const reconnCid = await createChannel(alicePage, guildId, 'Voice-Reconnect', 1);
    const diag = await alicePage.evaluate(
      async ({ cid }) => {
        // @ts-expect-error - Vite-served path resolved at browser runtime
        const mod = await import('/src/lib/ws/gateway-connection.ts');
        // `any`: the test deliberately reaches private fields (ws/wantConnected)
        // to simulate a transparent socket drop.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const conn: any = new mod.GatewayConnection({
          serverId: 'cloud-wp-reconnect-test',
          hostname: location.host,
          isCloud: true
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__wpReconn = conn;
        await conn.connect();
        await conn.waitForReady();
        conn.startWatchParty(cid, 'https://www.youtube.com/watch?v=abc12345678');
        await new Promise((r) => setTimeout(r, 400)); // let watch_start register
        conn.sendWatchJoin(cid); // host tile "mounts" → registry + watchJoins set
        await new Promise((r) => setTimeout(r, 200));
        const watchJoinsHasCid = conn.watchJoins?.has?.(cid) ?? false;
        // Transparent reconnect. Await the old socket's `close` event FIRST so
        // the gateway's own close handler runs (nulls this.ws, and — because
        // wantConnected is false — schedules no auto-reconnect) before we
        // re-dial. Otherwise the late close event clobbers the new socket.
        conn.wantConnected = false;
        const old = conn.ws;
        await new Promise<void>((res) => {
          old.addEventListener('close', () => res(), { once: true });
          old.close();
        });
        conn.wantConnected = true;
        await conn.connect(); // fresh socket → `open` handler re-emits watch_join (the fix)
        await conn.waitForReady();
        await new Promise((r) => setTimeout(r, 150)); // let the re-emitted join land
        return { watchJoinsHasCid, wsOpen: conn.ws?.readyState === 1 };
      },
      { cid: reconnCid }
    );
    expect(diag.watchJoinsHasCid, 'watchJoins tracked the channel').toBe(true);
    expect(diag.wsOpen, 'reconnected socket is open').toBe(true);

    // Past the grace window (1s in E2E) — without the fix the party is gone.
    await alicePage.waitForTimeout(2000);
    const survivor = (await getGuildWatchState(alicePage, guildId)).find(
      (e) => e.channel_id === reconnCid
    );
    expect(survivor?.state, 'party survived host reconnect').toBeTruthy();
    expect(survivor!.state!.host_user_id).toBe(aliceUserId);
    expect(survivor!.state!.source).toMatchObject({ type: 'youtube', embed_id: 'abc12345678' });

    // Cleanup: stop the party and tear down the test connection.
    await alicePage.evaluate(
      async ({ cid }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const conn: any = (window as any).__wpReconn;
        conn?.stopWatchParty?.(cid);
        await new Promise((r) => setTimeout(r, 100));
        conn?.disconnect?.();
      },
      { cid: reconnCid }
    );
  });

  test('detach handover: popup sibling socket keeps the party when the main socket leaves', async () => {
    // Regression for the "host detaching their party into a popup kills it" bug.
    // The popup is a separate window with its own gateway session (a sibling
    // socket of the same user). The frontend fix suppresses the inline tile's
    // `watch_leave` until the popup has joined, so the host's last socket never
    // leaves before the popup takes over. This drives that handover through the
    // real gateway + Redis at the WS layer (the tile itself needs LiveKit +
    // a YouTube iframe the harness deliberately avoids): once the popup socket
    // has joined, the main socket leaving must NOT end the party.
    const cid = await createChannel(alicePage, guildId, 'Voice-Detach', 1);

    // Main window: start + join (the host anchor; handle_start already joins
    // this socket, the explicit join mirrors the inline tile's onMount).
    await wsOpen(alicePage, 'wpmain');
    await wsSend(alicePage, 'wpmain', {
      op: 'watch_start',
      channel_id: cid,
      source_url: 'https://www.youtube.com/watch?v=abc12345678'
    });
    await wsWaitFor(alicePage, 'wpmain', 'watch_state');
    await wsSend(alicePage, 'wpmain', { op: 'watch_join', channel_id: cid });

    // Popup window: same user, sibling socket joins and takes over.
    await wsOpen(alicePage, 'wppopup');
    await wsSend(alicePage, 'wppopup', { op: 'watch_join', channel_id: cid });
    await wsWaitFor(alicePage, 'wppopup', 'watch_watchers', aliceUserId);

    // Main window leaves (reattach / main-window close). With the popup holding
    // the watcher anchor, the party survives — host stays Alice, not ended.
    await wsSend(alicePage, 'wpmain', { op: 'watch_leave', channel_id: cid });
    await expect
      .poll(async () => {
        const s = (await getGuildWatchState(alicePage, guildId)).find(
          (e) => e.channel_id === cid
        );
        return s?.state?.host_user_id;
      })
      .toBe(aliceUserId);

    // Cleanup: stop the party (host can stop from either of her sockets).
    await wsSend(alicePage, 'wppopup', { op: 'watch_stop', channel_id: cid });
    await wsClose(alicePage, 'wpmain');
    await wsClose(alicePage, 'wppopup');
  });

  test('watch_state push carries server_now for clock calibration', async () => {
    // The drift fix needs the server clock on the wire so viewers can calibrate
    // their offset and extrapolate position against the shared server clock
    // (not their own skewed Date.now()). Verify the push actually carries it.
    const cid = await createChannel(alicePage, guildId, 'Voice-Clock', 1);
    await wsOpen(alicePage, 'clk');
    await wsSend(alicePage, 'clk', {
      op: 'watch_start',
      channel_id: cid,
      source_url: 'https://youtu.be/abc12345678'
    });
    const frame = await wsWaitFor(alicePage, 'clk', 'watch_state', cid);
    expect(typeof frame.server_now, 'watch_state carries server_now').toBe('number');
    expect(frame.server_now as number).toBeGreaterThan(0);

    await wsSend(alicePage, 'clk', { op: 'watch_stop', channel_id: cid });
    await wsClose(alicePage, 'clk');
  });

  test('clockSync calibrates the server-clock offset (pure math)', async () => {
    // Exercises the real module with injected client times — deterministic, no
    // dependency on the machine's actual clock. This is the core of the drift
    // fix: position extrapolation runs on clockSync.now() (= local + offset)
    // instead of raw Date.now(), so each client's clock skew cancels out.
    const out = await alicePage.evaluate(async () => {
      // @ts-expect-error - Vite-served path resolved at browser runtime
      const mod = (await import('/src/lib/watch/clockSync.ts')) as {
        ClockSync: new () => {
          record: (s: number, c?: number) => void;
          now: (c?: number) => number;
          offsetMs: number;
          calibrated: boolean;
        };
      };
      const c = new mod.ClockSync();
      const before = c.now(1000); // offset 0 before any sample → identity
      c.record(10_000, 3_000); // first sample seeds directly → offset 7000
      const offset1 = c.offsetMs;
      const now1 = c.now(3_000); // 3000 + 7000
      c.record(10_500, 4_000); // sample 6500; EMA 0.2 → 7000 + 0.2*(6500-7000)
      const offset2 = c.offsetMs;
      c.record(Number.NaN, 5_000); // non-finite ignored
      const offset3 = c.offsetMs;
      return { before, offset1, now1, offset2, offset3, calibrated: c.calibrated };
    });
    expect(out.before).toBe(1000); // uncalibrated = raw local clock (no regression)
    expect(out.offset1).toBe(7000);
    expect(out.now1).toBe(10_000);
    expect(out.offset2).toBeCloseTo(6900, 6); // EMA pulled toward the new sample
    expect(out.offset3).toBeCloseTo(6900, 6); // NaN sample left it unchanged
    expect(out.calibrated).toBe(true);
  });
});
