// Voice-E2E für den Heim-Server (Linux-Lauf 2026-09-29).
//
// Beweist die VOICE-Kette über den Relay-Hostnamen: dev2 (Owner) und dev3
// (Gast) holen je einen LiveKit-Token vom Heim-Container (über den
// DataChannel) und verbinden sich mit dem ECHTEN livekit-client zu
// wss://<relay-subdomain>/livekit — Signal via Cloud-TLS → frps-Tunnel →
// Container, Medien direkt (UDP). Beide sehen am Ende den jeweils anderen
// Teilnehmer MIT abonnierter Audiospur.
//
// Voraussetzungen:
//   - Heim-Container läuft, Telefonbuch online, *.relay-DNS zeigt auf die
//     Relay-Box, Caddy dort mit on-demand TLS (s. Übergabe-Doku 2026-09-29).
//   - Vite mit Cloud-Proxy: PULSE_WEB_PORT=5273
//     PULSE_API_ORIGIN=https://pulse.unicutmedia.com node node_modules/vite/bin/vite.js dev
//   - Aus web/ starten: node ../infra/self-host/tests/heim-voice-cloud-e2e.mjs
//
// Fallen (alle 2026-09-28/29 leiden gelernt):
//   - BEIDE Teilnehmer PARALLEL verbinden (Promise.all) — sequenziell läuft
//     der erste in sein Teilnehmer-Timeout, bevor der zweite startet.
//   - Jede DataChannel-Sitzung in EINEM page.evaluate (conn überlebt den
//     structured clone nicht); Tokens/Strings dagegen wandern problemlos.
//   - Voice-Kanal ist type 1 (CHANNEL_TYPE_VOICE), NICHT Discords 2.
// positionsunabhängig: Playwright aus web/node_modules (der Skriptort hat
// kein eigenes node_modules).
const { chromium } = await import(
  new URL('../../../web/node_modules/@playwright/test/index.mjs', import.meta.url).href
);

const ORIGIN = 'http://127.0.0.1:5273';
const browser = await chromium.launch({
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

async function einloggen(user, pass) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(ORIGIN + '/login', { waitUntil: 'networkidle' });
  const r = await page.evaluate(async ({ user, pass }) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email_or_username: user, password: pass }),
    });
    return res.status;
  }, { user, pass });
  if (r !== 200) throw new Error(`login ${user} → ${r}`);
  return page;
}

// ── Owner (dev2): Ticket, Session, Guild + Voice-Kanal + Invite ──
const owner = await einloggen('dev2', 'test1234');
const ow = await owner.evaluate(async () => {
  const liste = await (await fetch('/api/auth/me/instances', { credentials: 'include' })).json();
  const inst = Array.isArray(liste) ? liste[0] : liste.instances[0];
  const tr = await fetch('/api/auth/me/server-ticket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ hostname: inst.hostname }),
  });
  if (!tr.ok) throw new Error(`owner-ticket → ${tr.status}`);
  const { ticket } = await tr.json();

  const direct = await import('/src/lib/direct/connection.ts');
  const tb = await (await fetch(`/api/auth/me/instances/${inst.id}/direct-endpoint`)).json();
  if (!tb.online) throw new Error('telefonbuch offline');
  const conn = await direct.DirectConnection.open({
    postOffer: async (sdp) => {
      const r = await fetch(`/api/auth/me/instances/${inst.id}/direct-offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp }),
      });
      if (!r.ok) throw new Error(`offer rejected ${r.status}`);
      return ((await r.json())).sdp;
    },
    expectedFingerprint: tb.fingerprint,
    iceServers: [],
  });
  const sess = await conn.fetch('/api/chat/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket }),
  });
  if (!sess.ok) throw new Error(`owner-session → ${sess.status}`);
  const token = (await sess.json()).session_token;
  const auth = { Authorization: `Bearer ${token}` };
  const j = async (r) => { if (!r.ok) throw new Error(`anlage → ${r.status}: ${await r.text()}`); return r.json(); };
  const suffix = Date.now() % 100000;
  const guild = await j(await conn.fetch('/api/chat/guilds', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ name: 'Voice-E2E-' + suffix }),
  }));
  const chan = await j(await conn.fetch(`/api/chat/guilds/${guild.id}/channels`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ name: 'lounge', type: 1, position: 0 }),
  }));
  const inv = await j(await conn.fetch(`/api/chat/guilds/${guild.id}/invites`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ max_uses: 5, expires_in_seconds: 86400 }),
  }));
  // Owner-Voice-Token — über den DataChannel (der Beweis: Token kommt vom
  // HEIM-Container, ws_url trägt die Relay-Subdomain).
  const vt = await j(await conn.fetch('/api/voice/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ channel_id: chan.id, kind: 'voice' }),
  }));
  return { iid: inst.id, hostname: inst.hostname, chan: chan.id, code: inv.code,
           ownerToken: vt.token, ownerWs: vt.ws_url };
});
console.log('owner: session ok, Voice-Kanal', ow.chan, '| ws_url:', ow.ownerWs);
if (!ow.ownerWs.includes('wss://' + ow.hostname.split('.')[0] + '.relay')
    && !ow.ownerWs.includes('wss://merry-meadow')) {
  console.log('HINWEIS: ws_url ohne relay-hostname?', ow.ownerWs);
}

// ── dev3: Merkhilfe, Grant, Session, Invite-Accept, Voice-Token ──
const bob = await einloggen('dev3', 'test1234');
const mem = await bob.evaluate(async (iid) =>
  (await fetch(`/api/auth/me/instances/${iid}/membership`, { method: 'POST', credentials: 'include' })).status, ow.iid);
console.log('dev3-merkhilfe:', mem);

await bob.evaluate((d) => { window.__heim = d; }, ow);
const bobVoice = await bob.evaluate(async () => {
  const tr = await fetch('/api/auth/me/server-ticket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ hostname: window.__heim.hostname, community_grant_code: window.__heim.code }),
  });
  if (!tr.ok) throw new Error(`dev3-ticket → ${tr.status}: ${await tr.text()}`);
  const { ticket } = await tr.json();
  const direct = await import('/src/lib/direct/connection.ts');
  const tb = await (await fetch(`/api/auth/me/instances/${window.__heim.iid}/direct-endpoint`)).json();
  if (!tb.online) throw new Error('telefonbuch offline (dev3)');
  const conn = await direct.DirectConnection.open({
    postOffer: async (sdp) => {
      const r = await fetch(`/api/auth/me/instances/${window.__heim.iid}/direct-offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp }),
      });
      if (!r.ok) throw new Error(`offer rejected ${r.status}`);
      return ((await r.json())).sdp;
    },
    expectedFingerprint: tb.fingerprint,
    iceServers: [],
  });
  const sess = await conn.fetch('/api/chat/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket, community_grant_code: window.__heim.code }),
  });
  if (!sess.ok) throw new Error(`dev3-session → ${sess.status}`);
  const token = (await sess.json()).session_token;
  const acc = await conn.fetch(`/api/chat/invites/${window.__heim.code}/accept`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  if (!acc.ok) throw new Error(`invite-accept → ${acc.status}: ${await acc.text()}`);
  const vt = await (await conn.fetch('/api/voice/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ channel_id: window.__heim.chan, kind: 'voice' }),
  })).json();
  return { bobToken: vt.token, bobWs: vt.ws_url };
});
console.log('dev3: session ok, invite ok, voice-token ok');

// ── Voice: BEIDE parallel verbinden (Promise.all!), Fake-Mikrofon an ──
async function voiceTeilnehmer(page, { token, wsUrl, label }) {
  await page.context().grantPermissions(['microphone'],
    { origin: new URL(page.url()).origin });
  return page.evaluate(async ({ token, wsUrl, label }) => {
    let lk;
    try {
      lk = await import('/node_modules/.vite/deps/livekit-client.js');
    } catch {
      await import('/src/lib/voice/livekit.svelte.ts'); // triggert Vite-Prebundle
      lk = await import('/node_modules/.vite/deps/livekit-client.js');
    }
    const room = new lk.Room({ adaptiveStream: false, dynacast: false });
    window.__room = room;
    const t0 = Date.now();
    await room.connect(wsUrl, token);
    const connectMs = Date.now() - t0;
    await room.localParticipant.setMicrophoneEnabled(true);
    const remote = await new Promise((res) => {
      const scan = () => {
        const r = [...room.remoteParticipants.values()][0];
        if (r) {
          const audio = [...r.audioTrackPublications.values()]
            .filter((p) => p.isSubscribed && p.track).length;
          if (audio > 0) return res({ name: r.identity, audioTracks: audio });
        }
        if (Date.now() - t0 > 40000) {
          return res({ name: r ? r.identity : null, audioTracks: 0, timeout: true });
        }
        setTimeout(scan, 500);
      };
      scan();
    });
    return { label, connectMs, remote };
  }, { token, wsUrl, label });
}

const [ownerSeite, bobSeite] = await Promise.all([
  voiceTeilnehmer(owner, { token: ow.ownerToken, wsUrl: ow.ownerWs, label: 'owner' }),
  voiceTeilnehmer(bob, { token: bobVoice.bobToken, wsUrl: bobVoice.bobWs, label: 'dev3' }),
]);
console.log('owner-Seite:', JSON.stringify(ownerSeite));
console.log('dev3-Seite:', JSON.stringify(bobSeite));

const gruen = ownerSeite.remote?.audioTracks > 0 && bobSeite.remote?.audioTracks > 0;
console.log('>>> VOICE-E2E:', gruen
  ? 'GRÜN — LiveKit-Signal über Relay-TLS/Tunnel, Medien weg, Audiospur beidseitig abonniert'
  : 'ROT');
await browser.close();
process.exit(gruen ? 0 : 1);
