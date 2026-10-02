// RTMPS-Ingest über den Host-tcpRelay — Windows-E2E (2026-10-01).
//
// Beweist die Strecke, die nur am Windows-Host existiert: Owner mintet eine
// RTMPS-Push-URL (Stream-Token OHNE WHIP-Wunsch → Owner-Erkennung →
// protocol=rtmp, push_url rtmps://localhost:1936/...), das im win-hq-sidecar
// mitgelieferte ffmpeg pusht auf 127.0.0.1:1936 — der Host-tcpRelay trägt die
// Verbindung in die podman-VM zum MediaMTX (`--network host` bindet 1936 nur
// IN der VM). Gegenbeweis: MediaMTX-Log meldet "is publishing" auf dem Pfad.
// (Der Lieferweg WHEP ist separat bewiesen, s. heim-stream-cloud-e2e.mjs.)
//
// Voraussetzungen wie heim-stream-cloud-e2e.mjs (Vite-Proxy :5273, Container
// online). Start aus web/ mit resources-podman auf PATH (podman-Logs):
//   PATH="…/desktop/resources-podman:$PATH" \
//   node ../infra/self-host/tests/heim-rtmps-relay-probe.mjs
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(
  new URL('../../../web/node_modules/@playwright/test/index.mjs', import.meta.url).href
);

const ORIGIN = 'http://127.0.0.1:5273';
const FFMPEG = fileURLToPath(new URL(
  '../../../streaming/win-hq-sidecar/ffmpeg-dist/n8.1-lgpl-shared/bin/ffmpeg.exe',
  import.meta.url,
));
const browser = await chromium.launch();

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

// ── Owner (dev2): Ticket, Session, Guild + Voice-Kanal, RTMPS-Stream-Token ──
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
  const guild = await j(await conn.fetch('/api/chat/guilds', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ name: 'Rtmps-Relay-' + (Date.now() % 100000) }),
  }));
  const chan = await j(await conn.fetch(`/api/chat/guilds/${guild.id}/channels`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ name: 'hq', type: 1, position: 0 }),
  }));
  // KEIN whip-Wunsch → Owner-Erkennung → protocol=rtmp (routes.py: owner_erkannt).
  const st = await j(await conn.fetch(`/api/chat/channels/${chan.id}/stream-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ slot: 0, remote_input: false }),
  }));
  return { pushUrl: st.push_url, protocol: st.protocol };
});
console.log('owner: protocol', ow.protocol, '| push_url:', ow.pushUrl);
if (!/^rtmps:\/\/(localhost|127\.0\.0\.1):1936\//.test(ow.pushUrl)) {
  throw new Error(`push_url trägt nicht den Relay-Weg: ${ow.pushUrl}`);
}

// ── ffmpeg pusht 12 s Testbild auf 127.0.0.1:1936 (nur der tcpRelay hört da) ──
const pfad = new URL(ow.pushUrl).pathname.slice(1);
console.log('ffmpeg →', pfad);
const ff = spawn(FFMPEG, [
  '-hide_banner', '-loglevel', 'warning',
  '-re', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-t', '12',
  // LGPL-Build ohne libx264 — h264_mf (Media Foundation) ist Windows-Bordmittel.
  '-c:v', 'h264_mf', '-b:v', '1M', '-pix_fmt', 'yuv420p', '-f', 'flv', ow.pushUrl,
]);
let ffFehler = '';
ff.stderr.on('data', (d) => { ffFehler += d.toString(); });
await new Promise((ok, schlecht) => {
  ff.on('error', schlecht);
  ff.on('close', (c) => (c === 0 ? ok() : schlecht(new Error(`ffmpeg exit ${c}: ${ffFehler.slice(-400)}`))));
});
console.log('ffmpeg: gesendet (exit 0)');

// ── Gegenbeweis: MediaMTX hat den Strom angenommen ──
const laufzeit = (() => {
  try { execSync('docker ps', { stdio: 'ignore' }); return 'docker'; } catch { return 'podman'; }
})();
const containerName = execSync(`${laufzeit} ps --format '{{.Names}}'`, { encoding: 'utf8' })
  .split('\n').map((n) => n.replace(/'/g, '').trim())
  .find((n) => n.startsWith('pulse-host'));
if (!containerName) throw new Error('kein pulse-host-Container läuft');
const log = execSync(
  `${laufzeit} logs ${containerName} --since 2m 2>&1 | grep -F "${pfad}" | tail -4`,
  { encoding: 'utf8', shell: 'bash' },
).trim();
console.log(`--- MediaMTX-Log (${laufzeit}, ${containerName}) ---`);
console.log(log || '(keine Zeilen)');
await browser.close();
const gruen = log.includes('is publishing');
console.log('>>> RTMPS-RELAY-PROBE:', gruen
  ? 'GRÜN — RTMPS-Ingest über Host-tcpRelay 1936 in die VM, MediaMTX publiziert'
  : 'ROT — kein "is publishing" im MediaMTX-Log');
process.exit(gruen ? 0 : 1);
