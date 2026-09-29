// Extern-Voice, Host-Seite (läuft lokal bei Michael): Owner verbindet per
// LAN in den Voice-Raum des Heim-Containers und wartet auf den externen
// Gast (Hetzner-Box). State-Datei für die Gast-Seite schreiben.
import fs from 'node:fs';
const { chromium } = await import(
  'file:///home/michael/Dokumente/pulse/web/node_modules/@playwright/test/index.mjs'
);
const ORIGIN = 'http://127.0.0.1:5273';
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });

const page = await (await browser.newContext()).newPage();
await page.goto(ORIGIN + '/login', { waitUntil: 'networkidle' });
const st = await page.evaluate(async () => {
  await fetch('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ email_or_username: 'dev2', password: 'test1234' }),
  });
  const liste = await (await fetch('/api/auth/me/instances', { credentials: 'include' })).json();
  const inst = Array.isArray(liste) ? liste[0] : liste.instances[0];
  const tr = await fetch('/api/auth/me/server-ticket', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ hostname: inst.hostname }),
  });
  const { ticket } = await tr.json();
  const direct = await import('/src/lib/direct/connection.ts');
  const tb = await (await fetch(`/api/auth/me/instances/${inst.id}/direct-endpoint`)).json();
  const conn = await direct.DirectConnection.open({
    postOffer: async (sdp) => {
      const r = await fetch(`/api/auth/me/instances/${inst.id}/direct-offer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp }),
      });
      return ((await r.json())).sdp;
    },
    expectedFingerprint: tb.fingerprint, iceServers: [],
  });
  const sess = await conn.fetch('/api/chat/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket }),
  });
  const token = (await sess.json()).session_token;
  const auth = { Authorization: `Bearer ${token}` };
  const j = async (r) => { if (!r.ok) throw new Error(`anlage → ${r.status}`); return r.json(); };
  const guild = await j(await conn.fetch('/api/chat/guilds', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ name: 'ExtVoice-' + (Date.now() % 100000) }),
  }));
  const chan = await j(await conn.fetch(`/api/chat/guilds/${guild.id}/channels`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ name: 'extern', type: 1, position: 0 }),
  }));
  const inv = await j(await conn.fetch(`/api/chat/guilds/${guild.id}/invites`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ max_uses: 5, expires_in_seconds: 3600 }),
  }));
  const vt = await j(await conn.fetch('/api/voice/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ channel_id: chan.id, kind: 'voice' }),
  }));
  return { iid: inst.id, hostname: inst.hostname, chan: chan.id, code: inv.code,
           ownerToken: vt.token, ownerWs: vt.ws_url };
});
console.log('host: anlage ok, ws_url', st.ownerWs);
fs.writeFileSync('/tmp/heim-extern-voice-state.json', JSON.stringify(st));

// Owner verbinden und auf den externen Gast warten.
const ergebnis = await page.evaluate(async (st) => {
  const lk = await import('/node_modules/.vite/deps/livekit-client.js');
  const room = new lk.Room({ adaptiveStream: false, dynacast: false });
  await room.connect(st.ownerWs, st.ownerToken);
  await room.localParticipant.setMicrophoneEnabled(true);
  const t0 = Date.now();
  const remote = await new Promise((res) => {
    const scan = () => {
      const r = [...room.remoteParticipants.values()][0];
      if (r) {
        const audio = [...r.audioTrackPublications.values()]
          .filter((p) => p.isSubscribed && p.track).length;
        return res({ identity: r.identity, audioTracks: audio });
      }
      if (Date.now() - t0 > 90000) return res(null);
      setTimeout(scan, 500);
    };
    scan();
  });
  return { connectMs: Date.now() - t0, remote };
}, st);
console.log('host-ergebnis:', JSON.stringify(ergebnis));
const gruen = ergebnis.remote && ergebnis.remote.audioTracks > 0;
console.log(gruen ? '>>> EXTERN-VOICE-HOST: externer Gast MIT Audiospur sichtbar' : '>>> EXTERN-VOICE-HOST: kein Gast');
await browser.close();
process.exit(gruen ? 0 : 1);
