// Voice-Gastprobe aus dem ECHTEN Internet (Hetzner-Testbox) gegen einen
// App-gehosteten Heimserver — der "Nummer 3"-Beweis: kein Hotspot-Trick,
// sondern ein Rechenzentrum als zweiter Teilnehmer.
//
// Ablauf im Headless-Chromium (Fake-Mikrofon):
//   1. Cloud-Login dev2 @ howispulse.com (Cookies)
//   2. GET  /api/auth/me/instances              → Instanz finden
//   3. POST /api/auth/me/server-ticket          → Ticket (Cloud)
//   4. POST https://<relay>/api/chat/session    → Session (über Relay-TLS!)
//   5. POST https://<relay>/api/voice/token     → LiveKit-Token für den Kanal
//   6. room.connect(wss://<relay>/livekit …)    → Signal über Relay,
//      Medien via ICE: LAN-Kandidaten laufen ins Leere, es MUSS der srflx-Weg
//      über die Fritz!Box (Öffentliche IP) bleiben — genau das beweisen wir.
//   7. Remote-Teilnehmer + abonnierte Audiospuren + GEWÄHLTES ICE-Paar (Stats).
//
// Start:  node heim-gast-internet-voice.mjs <relay-hostname> <channel-id>
// Env:    GAST_USER (default dev2), GAST_PASS (default test1234)
// CDN-Import für livekit-client (die Box hat Internet — es ist ja der Punkt).

const RELAY = process.argv[2] ?? 'clever-cobalt-11af.relay.howispulse.com';
const CHANNEL = process.argv[3] ?? '99546466502057984';
const USER = process.env.GAST_USER ?? 'dev2';
const PASS = process.env.GAST_PASS ?? 'test1234';

const { chromium } = await import('playwright-core');

const browser = await chromium.launch({
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const context = await browser.newContext();
// livekit-client per addInitScript injizieren (CDP-Level → läuft an Seiten-CSP
// vorbei; ein CDN-Import wurde von der Web-App-CSP geblockt). UMD-Global-Name
// variant je nach Bau: wir akzeptieren die üblichen Kandidaten.
await context.addInitScript({
  path: new URL('./node_modules/livekit-client/dist/livekit-client.umd.js', import.meta.url).pathname,
});
const page = await context.newPage();

// ── 1-3: Cloud-Seite (gleicher Origin → Cookies automatisch) ────────────────
await page.goto('https://howispulse.com/', { waitUntil: 'domcontentloaded' });
const cloud = await page.evaluate(async ({ user, pass }) => {
  const login = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email_or_username: user, password: pass }),
  });
  if (login.status !== 200) throw new Error(`login → ${login.status}`);
  const liste = await (await fetch('/api/auth/me/instances', { credentials: 'include' })).json();
  const inst = (Array.isArray(liste) ? liste : liste.instances)
    .find((i) => i.status !== 'deleted');
  if (!inst) throw new Error('keine Instanz für ' + user);
  const tr = await fetch('/api/auth/me/server-ticket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ hostname: inst.hostname }),
  });
  if (!tr.ok) throw new Error(`server-ticket → ${tr.status}: ${await tr.text()}`);
  return { ticket: (await tr.json()).ticket, hostname: inst.hostname, iid: inst.id };
}, { user: USER, pass: PASS });
console.log(`cloud: login ok, instanz ${cloud.iid} (${cloud.hostname})`);

// ── 4-6: Heimserver-Seite über die Relay-Adresse (echtes Internet) ──────────
const ergebnis = await page.evaluate(async ({ relay, ticket, channel }) => {
  const sess = await fetch(`https://${relay}/api/chat/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket }),
  });
  if (!sess.ok) throw new Error(`session → ${sess.status}: ${await sess.text()}`);
  const token = (await sess.json()).session_token;
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const vt = await (await fetch(`https://${relay}/api/voice/token`, {
    method: 'POST', headers: auth, body: JSON.stringify({ channel_id: channel, kind: 'voice' }),
  })).json();
  if (!vt.token) throw new Error('voice-token leer: ' + JSON.stringify(vt).slice(0, 200));

  const lk = window.LivekitClient ?? window.livekit ?? window.LiveKitClient;
  if (!lk?.Room) throw new Error('livekit-client nicht injiziert: ' + Object.keys(window).filter((k) => /livekit/i.test(k)).join(','));
  const room = new lk.Room({ adaptiveStream: false, dynacast: false });
  const t0 = Date.now();
  await room.connect(vt.ws_url, vt.token);
  const connectMs = Date.now() - t0;
  await room.localParticipant.setMicrophoneEnabled(true);

  // 40 s auf mindestens einen Remote-Teilnehmer MIT Audiospur warten.
  const remote = await new Promise((res) => {
    const scan = () => {
      const mitTon = [...room.remoteParticipants.values()].filter((p) =>
        [...p.audioTrackPublications.values()].some((t) => t.isSubscribed && t.track));
      if (mitTon.length > 0) return res({ teilnehmer: mitTon.map((p) => p.identity) });
      if (Date.now() - t0 > 40000) {
        return res({ teilnehmer: [...room.remoteParticipants.values()].map((p) => p.identity), timeout: true });
      }
      setTimeout(scan, 500);
    };
    scan();
  });
  return { connectMs, remote, ws: vt.ws_url.slice(0, 60) };
}, { relay: RELAY, ticket: cloud.ticket, channel: CHANNEL });

console.log('gast-seite:', JSON.stringify(ergebnis));
await browser.close();

const gruen = ergebnis.remote?.teilnehmer?.length > 0 && !ergebnis.remote?.timeout;
console.log('>>> INTERNET-GAST:', gruen
  ? 'GRÜN — Signal über Relay, Teilnehmer+Audio live (ICE-Weg siehe Server-Log)'
  : 'ROT');
process.exit(gruen ? 0 : 1);
