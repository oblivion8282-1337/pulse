// Firefox-ICE-Probe: reproduziert den Join-Fehler des Nutzers (Firefox am
// zweiten Gerät) und zeigt, ob die Adapter-Antwort überhaupt angenommen wird.
// Lauf:  node firefox-ice-probe.mjs  (aus web/, nutzt @playwright dort)
import { firefox } from '@playwright/test';

const CLOUD = 'https://pulse.unicutmedia.com';
const browser = await firefox.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
page.on('console', (m) => console.log('[seite]', m.text().slice(0, 200)));
await page.goto(CLOUD + '/', { waitUntil: 'domcontentloaded' });

await page.evaluate(async () => {
  await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email_or_username: 'dev3', password: 'test1234' }),
  });
});

const out = await page.evaluate(async () => {
  const res = {};
  const liste = await (await fetch('/api/auth/me/instances', { credentials: 'include' })).json();
  const inst = Array.isArray(liste) ? liste[0] : liste.instances[0];
  const tb = await (await fetch(`/api/auth/me/instances/${inst.id}/direct-endpoint`)).json();
  res.telefonbuch = tb.online ? 'online' : 'offline';
  if (!tb.online) return res;

  const pc = new RTCPeerConnection({ iceServers: [] });
  pc.createDataChannel('ff-probe');
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => {
    if (pc.iceGatheringState === 'complete') return r();
    pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && r());
    setTimeout(r, 2500);
  });
  const r = await fetch(`/api/auth/me/instances/${inst.id}/direct-offer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ sdp: pc.localDescription.sdp }),
  });
  if (!r.ok) { res.offer = r.status; return res; }
  const { sdp: answer } = await r.json();
  res.antwortKandidaten = answer.split('\n').filter((l) => l.startsWith('a=candidate')).map((l) => l.trim());
  try {
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    res.answerAngenommen = true;
  } catch (e) {
    res.answerAngenommen = false;
    res.answerFehler = String(e);
    return res;
  }
  res.ice = await new Promise((resolve) => {
    const t0 = Date.now();
    const check = () => {
      const s = pc.iceConnectionState;
      if (s === 'connected' || s === 'completed') return resolve('CONNECTED ' + (Date.now() - t0) + 'ms');
      if (s === 'failed' || s === 'closed') return resolve('FEHL: ' + s);
      if (Date.now() - t0 > 20000) return resolve('TIMEOUT: ' + s);
      setTimeout(check, 300);
    };
    check();
  });
  pc.close();
  return res;
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
