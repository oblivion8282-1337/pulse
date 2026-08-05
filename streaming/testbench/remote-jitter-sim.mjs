// Wie tief regelt Chromiums Jitter-Puffer auf einem P2P-Pfad?
//
// WOFUER: Die Fernsteuerung (`feat/remote-control-windows`) laeuft NICHT ueber
// MediaMTX, sondern P2P — Sidecar (webrtc-rs) direkt zum Browser. Im
// Latenzbudget der Machbarkeitsmessung (2026-07-21) steht der Jitter-Puffer mit
// 5-15 ms; gemessen wurde damals, dass diese Werte auf der Strecke reichen,
// NICHT was Chromium daraus macht. Genau daran haengt die Frage, ob der native
// Player als Fernsteuer-Fenster etwas bringt: sein Puffer ist stellbar,
// Chromiums nicht.
//
// WAS HIER GEMESSEN WIRD: `jitterBufferDelay / jitterBufferEmittedCount` aus
// getStats() — die mittlere Verweildauer eines Bildes im Empfangspuffer. Dazu
// `currentRoundTripTime` als KONTROLLE, dass die gesetzte Netzstoerung
// ueberhaupt wirkt (ohne diesen Nachweis misst man den Leerlauf und haelt ihn
// fuer ein Ergebnis).
//
// WAS ES NICHT IST: die echte Strecke. Sender ist hier Chromium selbst
// (Canvas -> H.264), nicht der Tee aus dem HQ-Encoder. Ein Chromium-Sender
// taktet gleichmaessiger als unser Tee, und der Puffer richtet sich nach der
// Gleichmaessigkeit der Ankunft. Das Ergebnis ist deshalb eine **untere
// Schranke** fuer Chromiums Puffer: liegt es schon hier hoch, liegt es real
// nicht niedriger. Liegt es niedrig, ist damit wenig gesagt.
//
//   node remote-jitter-sim.mjs --secs 40 --label ohne-stoerung
//
// Die Netzstoerung setzt `remote-jitter-sim.sh` davor (netem auf `lo`).
// Braucht die Abhaengigkeiten des Web-Pakets (`cd web && pnpm install`).

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const HIER = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function ladePlaywright() {
  const suchpfade = [resolve(HIER, '../../web'), resolve(HIER, '../..')];
  try {
    return require(require.resolve('@playwright/test', { paths: suchpfade }));
  } catch {
    console.error('Playwright nicht gefunden — einmalig `cd web && pnpm install`.');
    process.exit(1);
  }
}

function args() {
  const a = process.argv.slice(2);
  const wert = (name, vorgabe) => {
    const i = a.indexOf(name);
    return i >= 0 && a[i + 1] ? a[i + 1] : vorgabe;
  };
  return {
    secs: Number(wert('--secs', '40')),
    label: wert('--label', 'sim'),
    kbps: Number(wert('--kbps', '4000')),
    breite: Number(wert('--breite', '2560')),
    hoehe: Number(wert('--hoehe', '1440')),
    // Headless dekodiert ueber die Software-Anbindung. Fuer den Puffer duerfte
    // das gleichgueltig sein — aber genau solche Annahmen sind im Labor schon
    // zweimal geplatzt, deshalb ist SICHTBAR die Vorgabe.
    headless: a.includes('--headless'),
    out: wert('--out', ''),
  };
}

// ---------------------------------------------------------------------------
// Alles ab hier laeuft IM Browser.
// ---------------------------------------------------------------------------

/** Baut Sender und Empfaenger und verbindet sie direkt (kein Signaling-Server:
 *  beide Enden liegen auf derselben Seite, offer/answer werden uebergeben).
 *  Der Verkehr laeuft trotzdem echt ueber UDP auf 127.0.0.1 — nur deshalb
 *  greift `netem` auf `lo`. */
async function aufbauen({ breite, hoehe, kbps }) {
  // --- Bewegtbild. Pflicht: auf einem stehenden Bild sagt eine
  //     Puffer-Messung nichts, weil gleiche Bilder winzig kodieren und der
  //     Encoder dann ein Paketmuster erzeugt, das es real nicht gibt.
  //
  // Chromiums eingebautes Testbild (`--use-fake-device-for-media-stream`)
  // statt eines Canvas: der Canvas-Weg lief im Playwright-Chromium (Software-
  // GL) auf 5-20 statt 60 Bilder je Sekunde — gemessen im ersten Prueflauf
  // dieses Werkzeugs. Dann misst man den Sender, nicht den Empfangspuffer.
  // Das Testbild entsteht im Browser-Kern, kostet fast nichts und bewegt sich.
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { exact: breite }, height: { exact: hoehe }, frameRate: { ideal: 60 } },
  });
  const sender = new RTCPeerConnection();
  const empf = new RTCPeerConnection();
  window.__sender = sender;
  window.__empf = empf;
  window.__ptStart = performance.now();

  const tx = sender.addTransceiver(stream.getVideoTracks()[0], { direction: 'sendonly' });

  // H.264 erzwingen — der Fernsteuerungs-Pfad ist H.264 (Entscheidung v1:
  // "universeller/latenzaermster Decode"). Mit VP8/AV1 waeren die Frame-Groessen
  // und damit das Paketmuster andere.
  const caps = RTCRtpSender.getCapabilities('video');
  const h264 = caps.codecs.filter((k) => /H264/i.test(k.mimeType));
  if (h264.length && tx.setCodecPreferences) tx.setCodecPreferences(h264);

  const p = tx.sender.getParameters();
  p.encodings = [{ maxBitrate: kbps * 1000, maxFramerate: 60 }];
  await tx.sender.setParameters(p);

  const v = document.createElement('video');
  v.autoplay = true;
  v.muted = true;
  document.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
  v.style.cssText = 'width:100vw;height:100vh;object-fit:contain;display:block';
  document.body.appendChild(v);
  window.__video = v;
  empf.ontrack = (e) => { v.srcObject = e.streams[0]; };

  sender.onicecandidate = (e) => { if (e.candidate) empf.addIceCandidate(e.candidate); };
  empf.onicecandidate = (e) => { if (e.candidate) sender.addIceCandidate(e.candidate); };

  const offer = await sender.createOffer();
  await sender.setLocalDescription(offer);
  await empf.setRemoteDescription(offer);
  const answer = await empf.createAnswer();
  await empf.setLocalDescription(answer);
  await sender.setRemoteDescription(answer);

  await new Promise((fertig) => {
    const prüfen = () => {
      if (empf.connectionState === 'connected') fertig();
    };
    empf.addEventListener('connectionstatechange', prüfen);
    setTimeout(fertig, 10000);
    prüfen();
  });
  return empf.connectionState;
}

/** Eine Probe vom EMPFAENGER. Die Puffer-Zahlen sind kumulativ — der Aufrufer
 *  bildet die Differenz zwischen zwei Proben, sonst misst man den Mittelwert
 *  seit Verbindungsbeginn (also inklusive Einschwingen). */
async function probe() {
  const out = { t: (performance.now() - window.__ptStart) / 1000 };
  // outbound-rtp gibt es nur beim SENDER — im ersten Prueflauf stand hier
  // `null`, weil beide Seiten am Empfaenger abgefragt wurden.
  (await window.__sender.getStats()).forEach((s) => {
    if (s.type === 'outbound-rtp' && s.kind === 'video') {
      out.framesSent = s.framesSent;
      out.framesEncoded = s.framesEncoded;
      out.qualityLimit = s.qualityLimitationReason;
      out.encoder = s.encoderImplementation;
      out.bytesSent = s.bytesSent;
    }
  });
  const bericht = await window.__empf.getStats();
  bericht.forEach((s) => {
    if (s.type === 'inbound-rtp' && s.kind === 'video') {
      out.jbDelay = s.jitterBufferDelay;
      out.jbCount = s.jitterBufferEmittedCount;
      out.jitter = s.jitter;
      out.framesDecoded = s.framesDecoded;
      out.framesDropped = s.framesDropped;
      out.freezeCount = s.freezeCount;
      out.paketeVerloren = s.packetsLost;
      out.paketeEmpfangen = s.packetsReceived;
      out.decoder = s.decoderImplementation;
      out.breite = s.frameWidth;
      out.hoehe = s.frameHeight;
      out.totalProcessingDelay = s.totalProcessingDelay;
      out.totalAssemblyTime = s.totalAssemblyTime;
      out.framesAssembled = s.framesAssembledFromMultiplePackets;
    }
    if (s.type === 'candidate-pair' && s.nominated && s.currentRoundTripTime !== undefined) {
      out.rttMs = s.currentRoundTripTime * 1000;
    }
  });
  return out;
}

// ---------------------------------------------------------------------------

async function main() {
  const a = args();
  const { chromium } = ladePlaywright();
  const browser = await chromium.launch({
    headless: a.headless,
    args: [
      // Pflicht in jeder Messung: sonst bremst Chromium das Fenster, sobald es
      // nicht vorne liegt, und man misst die Messbedingungen mit
      // (`rueckname-2026-07-28-browser-drift.json`).
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--autoplay-policy=no-user-gesture-required',
      // Chromiums synthetische Kamera als Quelle (s. `aufbauen`).
      // `fps=60`: das Testbild laeuft sonst mit 20 Bildern je Sekunde, und bei
      // 50 ms Bildabstand verhaelt sich der Jitter-Puffer anders als bei 16,7.
      '--use-fake-device-for-media-stream=fps=60',
      '--use-fake-ui-for-media-stream',
    ],
  });
  // `navigator.mediaDevices` gibt es nur im sicheren Kontext, und `about:blank`
  // ist keiner (erster Prueflauf: "Cannot read properties of undefined").
  // `localhost` gilt als sicher — deshalb eine leere Seite von hier.
  const server = createServer((_q, a) => {
    a.writeHead(200, { 'content-type': 'text/html' });
    a.end('<!doctype html><meta charset=utf-8><title>remote-jitter-sim</title>');
  });
  await new Promise((f) => server.listen(0, '127.0.0.1', f));
  const port = server.address().port;

  const seite = await browser.newPage();
  await seite.goto(`http://127.0.0.1:${port}/`);
  seite.on('console', (m) => { if (m.type() === 'error') console.error('[browser]', m.text()); });

  const zustand = await seite.evaluate(aufbauen, {
    breite: a.breite, hoehe: a.hoehe, kbps: a.kbps,
  });
  if (zustand !== 'connected') {
    console.error(`Verbindung nicht zustande gekommen (${zustand}).`);
    await browser.close();
    server.close();
    process.exit(1);
  }

  const proben = [];
  for (let i = 0; i < a.secs; i += 1) {
    await seite.waitForTimeout(1000);
    proben.push(await seite.evaluate(probe));
  }
  await browser.close();
  server.close();

  // Einschwingen abschneiden: die ersten fuenf Sekunden enthalten den
  // Verbindungsaufbau, den ersten Keyframe und das Hochregeln der Bitrate.
  const gut = proben.filter((p) => p.t > 5 && p.jbCount > 0);
  if (gut.length < 3) {
    console.error('Zu wenige brauchbare Proben.');
    process.exit(1);
  }
  const erst = gut[0];
  const letzt = gut[gut.length - 1];

  // Mittlere Verweildauer im Puffer ueber das Fenster (Differenz der
  // kumulativen Zaehler, NICHT der Endwert geteilt durch den Endzaehler).
  const pufferMs = ((letzt.jbDelay - erst.jbDelay) / (letzt.jbCount - erst.jbCount)) * 1000;

  // Verlauf je Sekunde, damit ein Nachregeln sichtbar wird.
  const verlauf = [];
  for (let i = 1; i < gut.length; i += 1) {
    const dC = gut[i].jbCount - gut[i - 1].jbCount;
    if (dC > 0) verlauf.push(Number((((gut[i].jbDelay - gut[i - 1].jbDelay) / dC) * 1000).toFixed(1)));
  }

  const rtts = gut.map((p) => p.rttMs).filter((x) => x !== undefined);
  const ergebnis = {
    label: a.label,
    sekunden: a.secs,
    aufloesung: `${letzt.breite}x${letzt.hoehe}`,
    decoder: letzt.decoder,
    puffer_ms_mittel: Number(pufferMs.toFixed(1)),
    puffer_ms_verlauf: verlauf,
    puffer_ms_min: Math.min(...verlauf),
    puffer_ms_max: Math.max(...verlauf),
    rtt_ms_median: rtts.length ? Number(rtts.sort((x, y) => x - y)[Math.floor(rtts.length / 2)].toFixed(1)) : null,
    paket_jitter_ms: Number((letzt.jitter * 1000).toFixed(2)),
    encoder: letzt.encoder,
    qualitaets_bremse: letzt.qualityLimit,
    bilder_gesendet: letzt.framesSent - erst.framesSent,
    bilder_dekodiert: letzt.framesDecoded - erst.framesDecoded,
    bilder_verworfen: letzt.framesDropped - erst.framesDropped,
    freezes: letzt.freezeCount - erst.freezeCount,
    pakete_empfangen: letzt.paketeEmpfangen - erst.paketeEmpfangen,
    pakete_verloren: letzt.paketeVerloren - erst.paketeVerloren,
  };
  console.log(JSON.stringify(ergebnis, null, 1));
  if (a.out) writeFileSync(a.out, JSON.stringify(ergebnis, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
