// Extern-ICE-Probe: läuft in einem Chromium-Container auf der HETZNER-Box
// und spielt einen Freund außerhalb des Heimnetzes. Beweisziel: der
// Direktpfad trägt übers Internet (srflx öffentliche Adresse), ohne
// manuelle Portfreigabe (Lochungs-Modus der Server-App).
// Expected pair: lokal host 77.42.71.166 (Box, öffentlich) <-> remote srflx
// 46.128.161.204:7900 (Heim, NAT-gelocht).
const { chromium } = require('playwright-core');

const CLOUD = 'https://pulse.unicutmedia.com';

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  await page.goto(CLOUD + '/', { waitUntil: 'domcontentloaded' });

  const login = await page.evaluate(async () => {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email_or_username: 'dev3', password: 'test1234' }),
    });
    return r.status;
  });
  console.log('login dev3 (aus dem Internet):', login);

  const ergebnis = await page.evaluate(async () => {
    const liste = await (await fetch('/api/auth/me/instances', { credentials: 'include' })).json();
    const inst = Array.isArray(liste) ? liste[0] : liste.instances[0];
    const tb = await (await fetch(`/api/auth/me/instances/${inst.id}/direct-endpoint`)).json();
    const out = { telefonbuch: tb };
    if (!tb.online) return out;

    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    const dc = pc.createDataChannel('extern-probe');
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((res) => {
      if (pc.iceGatheringState === 'complete') return res();
      pc.addEventListener('icegatheringstatechange', () =>
        pc.iceGatheringState === 'complete' && res());
      setTimeout(res, 2500);
    });
    const r = await fetch(`/api/auth/me/instances/${inst.id}/direct-offer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ sdp: pc.localDescription.sdp }),
    });
    out.offerStatus = r.status;
    if (!r.ok) return out;
    const { sdp: answer } = await r.json();
    out.answerKandidaten = [...answer.matchAll(/typ (\w+)/g)].map((m) => m[1]);
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });

    out.ice = await new Promise((res) => {
      const t0 = Date.now();
      const check = () => {
        const s = pc.iceConnectionState;
        if (s === 'connected' || s === 'completed') return res('CONNECTED nach ' + (Date.now() - t0) + 'ms');
        if (s === 'failed' || s === 'closed') return res('FEHLGESCHLAGEN: ' + s);
        if (Date.now() - t0 > 25000) return res('TIMEOUT: ' + s);
        setTimeout(check, 300);
      };
      check();
    });

    if (String(out.ice).startsWith('CONNECTED')) {
      // Gewähltes Paar aus den Stats — der Typ-Beweis (srflx trägt).
      out.datachannel = dc.readyState;
      const stats = await pc.getStats();
      const kand = {};
      let pair = null;
      stats.forEach((s) => {
        if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) pair = s;
        if (s.type === 'local-candidate') kand[s.id] = s;
        if (s.type === 'remote-candidate') kand[s.id] = s;
      });
      if (pair) {
        const l = kand[pair.localCandidateId];
        const f = kand[pair.remoteCandidateId];
        out.paar = {
          lokal: `${l.candidateType} ${l.ip}:${l.port}`,
          entfernte: `${f.candidateType} ${f.ip}:${f.port}`,
        };
      }
    }
    pc.close();
    return out;
  });

  console.log(JSON.stringify(ergebnis, null, 1));
  const gruen = String(ergebnis.ice || '').startsWith('CONNECTED')
    && ergebnis.paar && String(ergebnis.paar.entfernte).startsWith('srflx');
  console.log(gruen ? '>>> EXTERN-ICE: GRÜN — Internet-Pfad (srflx) trägt' : '>>> EXTERN-ICE: ROT/SIEHE OBEN');
  await browser.close();
  process.exit(gruen ? 0 : 1);
})();
