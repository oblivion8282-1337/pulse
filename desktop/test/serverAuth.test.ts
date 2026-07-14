import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAccessExpired, jwtPayload, loadAuth, saveAuth, clearAuth,
  refreshTokens, createTokenGetter, HOST_AUTH_KEY,
} from '../electron/serverAuth.ts';

// ── Hilfen ───────────────────────────────────────────────────────────────────
function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** JWT mit gegebenem exp (Unix-Sekunden). Signatur ist egal — nur `exp` zählt. */
function jwt(expEpoch: number): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ exp: expEpoch })}.sig`;
}
const soon = () => Math.floor(Date.now() / 1000) + 3600; // 1h in der Zukunft
const past = () => Math.floor(Date.now() / 1000) - 10;   // abgelaufen

function fakeStore(init: Record<string, unknown> = {}) {
  const m: Record<string, unknown> = { ...init };
  return {
    get: (k: string) => m[k],
    set: (k: string, v: unknown) => { if (v === undefined) delete m[k]; else m[k] = v; },
    _m: m,
  };
}

interface FakeResp { status: number; json?: unknown; throw?: boolean }
function fakeFetch(...responses: FakeResp[]) {
  const calls: { url: string; opts: unknown }[] = [];
  const fn = (async (url: string, opts: unknown) => {
    calls.push({ url, opts });
    const r = responses[calls.length - 1] ?? responses[responses.length - 1];
    if (r.throw) throw new Error('network');
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.json };
  }) as unknown as typeof fetch & { calls: typeof calls };
  (fn as { calls: typeof calls }).calls = calls;
  return fn;
}

// ── jwtPayload / isAccessExpired ─────────────────────────────────────────────
test('jwtPayload: liest exp aus dem Payload', () => {
  const p = jwtPayload(jwt(1234567890));
  assert.equal(p?.exp, 1234567890);
});
test('jwtPayload: Müll → null', () => {
  assert.equal(jwtPayload('nicht.ein.jwt.zuviel'), null);
  assert.equal(jwtPayload('kaputt'), null);
});
test('isAccessExpired: Zukunft → false, Vergangenheit → true', () => {
  assert.equal(isAccessExpired(jwt(soon())), false);
  assert.equal(isAccessExpired(jwt(past())), true);
});
test('isAccessExpired: fehlendes exp → true (fail-safe → Refresh)', () => {
  const noExp = `${b64url({ alg: 'none' })}.${b64url({ sub: '1' })}.sig`;
  assert.equal(isAccessExpired(noExp), true);
});

// ── Store-I/O ────────────────────────────────────────────────────────────────
test('saveAuth/loadAuth/clearAuth: Roundtrip + korrekter Key', () => {
  const s = fakeStore();
  saveAuth(s, { accessToken: 'a', refreshToken: 'r' });
  assert.deepEqual(s._m[HOST_AUTH_KEY], { accessToken: 'a', refreshToken: 'r' });
  assert.deepEqual(loadAuth(s), { accessToken: 'a', refreshToken: 'r' });
  clearAuth(s);
  assert.equal(loadAuth(s), null);
});
test('loadAuth: unvollständige/fehlende Tokens → null', () => {
  assert.equal(loadAuth(fakeStore()), null);
  assert.equal(loadAuth(fakeStore({ [HOST_AUTH_KEY]: { accessToken: 'a' } })), null);
  assert.equal(loadAuth(fakeStore({ [HOST_AUTH_KEY]: 'nonsense' })), null);
});

// ── refreshTokens: Status-Verdikte ───────────────────────────────────────────
test('refreshTokens: 200 → neue Tokens', async () => {
  const f = fakeFetch({ status: 200, json: { access_token: 'A2', refresh_token: 'R2' } });
  const r = await refreshTokens('https://c', 'R1', f);
  assert.deepEqual(r, { tokens: { accessToken: 'A2', refreshToken: 'R2' } });
});
test('refreshTokens: 401 → dead:true (Family-Revoke, Tokens tot)', async () => {
  const r = await refreshTokens('https://c', 'R1', fakeFetch({ status: 401 }));
  assert.deepEqual(r, { tokens: null, dead: true });
});
test('refreshTokens: 5xx → dead:false (transient, behalten)', async () => {
  const r = await refreshTokens('https://c', 'R1', fakeFetch({ status: 503 }));
  assert.deepEqual(r, { tokens: null, dead: false });
});
test('refreshTokens: Netzfehler → dead:false', async () => {
  const r = await refreshTokens('https://c', 'R1', fakeFetch({ status: 0, throw: true }));
  assert.deepEqual(r, { tokens: null, dead: false });
});
test('refreshTokens: 200 aber unvollständige Antwort → dead:false', async () => {
  const r = await refreshTokens('https://c', 'R1', fakeFetch({ status: 200, json: { access_token: 'A2' } }));
  assert.deepEqual(r, { tokens: null, dead: false });
});

// ── createTokenGetter ────────────────────────────────────────────────────────
test('getAccessToken: keine Tokens → null (kein fetch)', async () => {
  const f = fakeFetch({ status: 200, json: {} });
  const get = createTokenGetter(fakeStore(), f);
  assert.equal(await get('https://c'), null);
  assert.equal((f as unknown as { calls: unknown[] }).calls.length, 0);
});
test('getAccessToken: gültiger Access → direkt zurück, kein Refresh', async () => {
  const s = fakeStore({ [HOST_AUTH_KEY]: { accessToken: jwt(soon()), refreshToken: 'R1' } });
  const f = fakeFetch({ status: 200, json: {} });
  const get = createTokenGetter(s, f);
  const tok = await get('https://c');
  assert.equal(tok, s._m[HOST_AUTH_KEY] && (s._m[HOST_AUTH_KEY] as { accessToken: string }).accessToken);
  assert.equal((f as unknown as { calls: unknown[] }).calls.length, 0);
});
test('getAccessToken: abgelaufen → refresht, persistiert Rotation, gibt neuen zurück', async () => {
  const s = fakeStore({ [HOST_AUTH_KEY]: { accessToken: jwt(past()), refreshToken: 'R1' } });
  const newAccess = jwt(soon());
  const f = fakeFetch({ status: 200, json: { access_token: newAccess, refresh_token: 'R2' } });
  const get = createTokenGetter(s, f);
  assert.equal(await get('https://c'), newAccess);
  assert.deepEqual(loadAuth(s), { accessToken: newAccess, refreshToken: 'R2' });
});
test('getAccessToken: Refresh 401 → Store gelöscht, null', async () => {
  const s = fakeStore({ [HOST_AUTH_KEY]: { accessToken: jwt(past()), refreshToken: 'R1' } });
  const get = createTokenGetter(s, fakeFetch({ status: 401 }));
  assert.equal(await get('https://c'), null);
  assert.equal(loadAuth(s), null); // Family-Revoke → Re-Login erzwungen
});
test('getAccessToken: Refresh Netzfehler → Tokens behalten, null', async () => {
  const expiredAccess = jwt(past());
  const s = fakeStore({ [HOST_AUTH_KEY]: { accessToken: expiredAccess, refreshToken: 'R1' } });
  const get = createTokenGetter(s, fakeFetch({ status: 0, throw: true }));
  assert.equal(await get('https://c'), null);
  // Transienter Fehler → Tokens bleiben unangetastet für einen späteren Retry.
  assert.deepEqual(loadAuth(s), { accessToken: expiredAccess, refreshToken: 'R1' });
});
test('getAccessToken: Single-Flight — parallele Aufrufer teilen EINEN Refresh', async () => {
  const s = fakeStore({ [HOST_AUTH_KEY]: { accessToken: jwt(past()), refreshToken: 'R1' } });
  const newAccess = jwt(soon());
  const f = fakeFetch({ status: 200, json: { access_token: newAccess, refresh_token: 'R2' } });
  const get = createTokenGetter(s, f);
  const [a, b] = await Promise.all([get('https://c'), get('https://c')]);
  assert.equal(a, newAccess);
  assert.equal(b, newAccess);
  assert.equal((f as unknown as { calls: unknown[] }).calls.length, 1); // nur EIN Refresh
});
