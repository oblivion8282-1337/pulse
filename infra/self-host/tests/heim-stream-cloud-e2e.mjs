// Streaming-E2E für den Heim-Server (Linux-Lauf, 2026-09-30).
//
// Beweist die STREAMING-Kette über den Relay-Hostnamen — derselbe Weg wie in
// Produktion: dev2 mintet über den DataChannel einen WHIP-Stream-Token
// (remote_input-Flag gesetzt), published einen echten Canvas-Stream per
// WebRTC an MediaMTX (HTTPS → Cloud-TLS → frps-Tunnel → Container), dev3 liest
// denselben Stream per WHEP und dekodiert echte Frames. Nachweis zusätzlich
// in den MediaMTX-Logs des Containers (publish/reader-Sessions).
//
// Voraussetzungen wie heim-voice-cloud-e2e.mjs (Vite-Proxy auf :5273,
// Container online, *.relay-DNS + on-demand TLS am Relay-Eingang).
// Aus web/ starten: node ../infra/self-host/tests/heim-stream-cloud-e2e.mjs
//
// Fallen:
//   - SDP-POSTs bewusst aus NODE, nicht aus der Seite: WHIP/WHEP-Endpoints
//     sind Cross-Origin zur Seiten-Origin — Node kennt kein CORS.
//   - WHEP braucht einen AKTIVEN Stream (stream:active im Container-Redis)
//     → erst publishen, dann WHEP ziehen.
//   - Jede DataChannel-Sitzung in EINEM page.evaluate (structured clone).
const { chromium } = await import(
  new URL('../../../web/node_modules/@playwright/test/index.mjs', import.meta.url).href
);

const ORIGIN = 'http://127.0.0.1:5273';
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

// ── Owner (dev2): Ticket, Session, Guild + Voice-Kanal, WHIP-Stream-Token ──
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
    body: JSON.stringify({ name: 'Stream-E2E-' + (Date.now() % 100000) }),
  }));
  const chan = await j(await conn.fetch(`/api/chat/guilds/${guild.id}/channels`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ name: 'hq', type: 1, position: 0 }),
  }));
  const inv = await j(await conn.fetch(`/api/chat/guilds/${guild.id}/invites`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ max_uses: 5, expires_in_seconds: 86400 }),
  }));
  const st = await j(await conn.fetch(`/api/chat/channels/${chan.id}/stream-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ protocol: 'whip', slot: 0, remote_input: true }),
  }));
  return { iid: inst.id, hostname: inst.hostname, chan: chan.id, code: inv.code,
           pushUrl: st.push_url, ownerUserId: guild.owner_id };
});
console.log('owner: session ok, Voice-Kanal', ow.chan);
console.log('push_url:', ow.pushUrl);
if (!ow.pushUrl.startsWith('https://') || !ow.pushUrl.includes('/whep/')) {
  console.log('WARNUNG: push_url trägt nicht den Relay-/whep-Pfad!');
}

// ── Owner published: Canvas → WHIP (SDP-POST aus Node, keine CORS-Falle) ──
const publishOffer = await owner.evaluate(async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 640; canvas.height = 360;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  let n = 0;
  window.__heimDraw = setInterval(() => {
    ctx.fillStyle = `hsl(${(n = (n + 7) % 360)} 80% 45%)`;
    ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = '#fff';
    ctx.font = '40px sans-serif';
    ctx.fillText('HEIM-STREAM ' + n, 40, 180);
  }, 66);
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  window.__heimPc = pc;
  canvas.captureStream(15).getTracks().forEach((t) => pc.addTrack(t));
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((res) => {
    if (pc.iceGatheringState === 'complete') return res();
    pc.addEventListener('icegatheringstatechange', () =>
      pc.iceGatheringState === 'complete' && res());
    setTimeout(res, 2500);
  });
  return pc.localDescription.sdp;
});

const pushRes = await fetch(ow.pushUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/sdp' },
  body: publishOffer,
});
console.log('WHIP-POST:', pushRes.status);
if (!pushRes.ok) throw new Error('WHIP publish abgelehnt: ' + (await pushRes.text()).slice(0, 200));
const publishAnswer = await pushRes.text();
const pubState = await owner.evaluate(async (answer) => {
  await window.__heimPc.setRemoteDescription({ type: 'answer', sdp: answer });
  return new Promise((res) => {
    const t0 = Date.now();
    const check = () => {
      const s = window.__heimPc.connectionState;
      if (s === 'connected') return res('CONNECTED nach ' + (Date.now() - t0) + 'ms');
      if (s === 'failed' || s === 'closed') return res('FEHLER: ' + s);
      if (Date.now() - t0 > 20000) return res('TIMEOUT: ' + s);
      setTimeout(check, 300);
    };
    check();
  });
}, publishAnswer);
console.log('Publish-PC:', pubState);
// Stream aktiv halten (stream:active im Redis), bis der Viewer läuft.
await owner.waitForTimeout(3000);

// ── dev3: Merkhilfe, Grant, Session, Invite, WHEP-URL (remote_input-Flag!) ──
const bob = await einloggen('dev3', 'test1234');
await bob.evaluate(async (iid) => {
  await fetch(`/api/auth/me/instances/${iid}/membership`, { method: 'POST', credentials: 'include' });
}, ow.iid);
await bob.evaluate((d) => { window.__heim = d; }, ow);
const bobWhep = await bob.evaluate(async () => {
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
  const w = await (await conn.fetch(
    `/api/chat/channels/${window.__heim.chan}/whep?user_id=${encodeURIComponent(window.__heim.ownerUserId ?? '')}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )).json();
  return { whepUrl: w.whep_url, remoteInput: w.remote_input, codec: w.codec ?? 'h264', token };
});
console.log('dev3: whep_url ok, remote_input-Flag:', bobWhep.remoteInput, '| codec:', bobWhep.codec);

// ── dev3 liest per WHEP und zählt dekodierte Frames ──
const viewOffer = await bob.evaluate(async () => {
  const video = document.createElement('video');
  video.muted = true; video.autoplay = true;
  document.body.appendChild(video);
  window.__heimVideo = video;
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });
  window.__heimViewPc = pc;
  pc.ontrack = (e) => { video.srcObject = e.streams[0]; };
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((res) => {
    if (pc.iceGatheringState === 'complete') return res();
    pc.addEventListener('icegatheringstatechange', () =>
      pc.iceGatheringState === 'complete' && res());
    setTimeout(res, 2500);
  });
  return pc.localDescription.sdp;
});

const whepRes = await fetch(bobWhep.whepUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/sdp' },
  body: viewOffer,
});
console.log('WHEP-POST:', whepRes.status);
if (!whepRes.ok) throw new Error('WHEP abgelehnt: ' + (await whepRes.text()).slice(0, 200));
const viewAnswer = await whepRes.text();
const viewResult = await bob.evaluate(async (answer) => {
  const pc = window.__heimViewPc;
  await pc.setRemoteDescription({ type: 'answer', sdp: answer });
  const zustand = await new Promise((res) => {
    const t0 = Date.now();
    const check = () => {
      const s = pc.connectionState;
      if (s === 'connected') return res('CONNECTED nach ' + (Date.now() - t0) + 'ms');
      if (s === 'failed' || s === 'closed') return res('FEHLER: ' + s);
      if (Date.now() - t0 > 20000) return res('TIMEOUT: ' + s);
      setTimeout(check, 300);
    };
    check();
  });
  const frames = await new Promise((res) => {
    let count = 0;
    const v = window.__heimVideo;
    const mess = () => {
      if ('requestVideoFrameCallback' in v) {
        const tick = () => { count++; if (count < 100000) v.requestVideoFrameCallback(tick); };
        v.requestVideoFrameCallback(tick);
      }
      setTimeout(() => res(count), 4000);
    };
    setTimeout(mess, 1500);
  });
  return { zustand, frames };
}, viewAnswer);
console.log('Viewer-PC:', viewResult.zustand, '| dekodierte Frames in 4s:', viewResult.frames);

// ── MediaMTX-Log als Gegenbeweis ──
// Runtime-Agnostik: docker (Linux-E2E) ODER podman (Windows-E2E 2026-10-01),
// Container-Name je Welt-Suffix aufgelöst (pulse-host-<welt>).
const { execSync } = await import('node:child_process');
const laufzeit = (() => {
  try { execSync('docker ps', { stdio: 'ignore' }); return 'docker'; } catch { return 'podman'; }
})();
const containerName = execSync(`${laufzeit} ps --format '{{.Names}}'`, { encoding: 'utf8' })
  .split('\n').map((n) => n.replace(/'/g, '').trim())
  .find((n) => n.startsWith('pulse-host'));
if (!containerName) throw new Error('kein pulse-host-Container läuft');
const mtxLog = execSync(
  `${laufzeit} logs ${containerName} --since 3m 2>&1 | grep -iE "whip|whep|publish|is publishing|reader" | tail -6`,
  { encoding: 'utf8', shell: 'bash' }
).trim();
console.log(`--- MediaMTX-Log (${laufzeit}, ${containerName}) ---`);
console.log(mtxLog || '(keine Zeilen)');

const gruen = String(pubState).startsWith('CONNECTED')
  && String(viewResult.zustand).startsWith('CONNECTED')
  && viewResult.frames > 30;
console.log('>>> STREAM-E2E:', gruen
  ? 'GRÜN — WHIP-Publish + WHEP-Wiedergabe über Relay-TLS/Tunnel, Frames dekodiert'
  : 'ROT');
await browser.close();
process.exit(gruen ? 0 : 1);
