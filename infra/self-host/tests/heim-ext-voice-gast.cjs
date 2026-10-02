// Extern-Voice, Gast-Seite (läuft im Chromium-Container auf der Hetzner-Box,
// --network host): dev3 loggt sich aus dem Internet ein, holt über die
// Cloud + Relay-Weg den Voice-Token und verbindet sich mit dem Voice-Raum
// im Heim-Container. Beweis: Voice-Medien-UDP durchs NAT-Loch von außen.
const { chromium } = require('playwright-core');
const fs = require('node:fs');

const st = JSON.parse(fs.readFileSync('/tmp/heim-extern-voice-state.json', 'utf8'));
const CLOUD = 'https://pulse.unicutmedia.com';

(async () => {
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
           '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await (await browser.newContext()).newPage();
  await page.goto(CLOUD + '/', { waitUntil: 'domcontentloaded' });

  // Relay-Basis aus der State (hostname) — Fetches zur Relay sind CORS-erlaubt
  // für die Cloud-Origin (CORS_ALLOW_ORIGINS im Container).
  const tokenDaten = await page.evaluate(async (st) => {
    const CLOUD = 'https://pulse.unicutmedia.com';
    const rel = `https://${st.hostname}`;
    const login = await fetch(`${CLOUD}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ email_or_username: 'dev3', password: 'test1234' }),
    });
    if (login.status !== 200) throw new Error('login → ' + login.status);
    await fetch(`${CLOUD}/api/auth/me/instances/${st.iid}/membership`, {
      method: 'POST', credentials: 'include',
    });
    const tr = await fetch(`${CLOUD}/api/auth/me/server-ticket`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ hostname: st.hostname, community_grant_code: st.code }),
    });
    if (!tr.ok) throw new Error('ticket → ' + tr.status + ': ' + await tr.text());
    const { ticket } = await tr.json();
    const sess = await fetch(`${rel}/api/chat/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ ticket, community_grant_code: st.code }),
    });
    if (!sess.ok) throw new Error('session → ' + sess.status + ': ' + await sess.text());
    const sessionToken = (await sess.json()).session_token;
    const acc = await fetch(`${rel}/api/chat/invites/${st.code}/accept`, {
      method: 'POST', headers: { Authorization: `Bearer ${sessionToken}` },
    });
    if (!acc.ok) throw new Error('invite-accept → ' + acc.status);
    const vt = await fetch(`${rel}/api/voice/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({ channel_id: st.chan, kind: 'voice' }),
    });
    if (!vt.ok) throw new Error('voice-token → ' + vt.status + ': ' + await vt.text());
    return await vt.json();
  }, st);
  console.log('gast: ticket+session+invite+voice-token ok | ws:', tokenDaten.ws_url);

  // livekit-client wird aus der Datei injiziert (kein Netz, kein Mixed-Content).
  await page.addScriptTag({ path: '/probe/livekit.umd.js' });
  const ergebnis = await page.evaluate(async (td) => {
    const grant = async () => {
      try { await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { /* fake */ }
    };
    await grant();
    const room = new window.LivekitClient.Room({ adaptiveStream: false, dynacast: false });
    await room.connect(td.ws_url, td.token);
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
        if (Date.now() - t0 > 60000) return res(null);
        setTimeout(scan, 500);
      };
      scan();
    });
    return { connectMs: Date.now() - t0, remote };
  }, tokenDaten);
  console.log('gast-ergebnis:', JSON.stringify(ergebnis));
  const gruen = ergebnis.remote && ergebnis.remote.audioTracks > 0;
  console.log(gruen ? '>>> EXTERN-VOICE-GAST: Owner MIT Audiospur sichtbar' : '>>> EXTERN-VOICE-GAST: kein Owner');
  await browser.close();
  process.exit(gruen ? 0 : 1);
})();
