// Ein WHEP-Zuschauer im echten Chromium — für alles, was der native Player
// NICHT beantworten kann.
//
// WARUM ES DAS BRAUCHT: Der Messstand fährt bisher ausschließlich den nativen
// Player. Der hat einen EIGENEN FlexFEC-Empfänger und einen eigenen
// WHEP-Client; über das Verhalten von Browser und Electron sagt eine Messung
// mit ihm deshalb nichts. Genau dort muss der Weg aber auch tragen — Pulse ist
// web-first, und die Electron-App ist Chromium.
//
// Was hier gemessen wird, ist nicht simuliert: es läuft im selben Chromium, das
// Playwright für die E2E-Tests benutzt (`--electron` fährt stattdessen die
// Electron-Fassung, also exakt die der App).
//
// DIE ZWEI FRAGEN, für die es gebaut wurde (2026-07-31):
//  1. Enthält die SDP-Antwort unseres gepatchten MediaMTX eine
//     `a=ssrc-group:FEC-FR <video-ssrc> <fec-ssrc>`? Chromium legt den
//     FlexFEC-Empfangsstrom NUR dann an — der Payload-Type allein genügt
//     nicht (libwebrtc: ConfigureReceiverRtp → GetFecFrSsrc →
//     FlexfecReceiveStream::Config::IsCompleteAndEnabled).
//  2. Kommen dann tatsächlich Paritätspakete an? `fecPacketsReceived` in
//     getStats() ist der Beweis: libwebrtc holt den Wert aus
//     `flexfec_stream_->GetStats()`, er ist also nur ungleich null, wenn der
//     Empfangsstrom wirklich existiert.
//
// CORS: Der WHEP-POST läuft in Node, nicht im Browser. Der Browser erzeugt nur
// das Offer und bekommt die Antwort zurückgereicht — sonst scheiterte die
// Verhandlung an der Herkunftsprüfung, ohne dass es etwas mit WebRTC zu tun
// hätte.
//
//   node browser-whep.mjs --url "https://host/whep/<pfad>/whep?token=…" --secs 30
//   node browser-whep.mjs --url … --electron        # in der Electron-Fassung
//
// Braucht die Abhängigkeiten des Web-Pakets (`cd web && pnpm install`).

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

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
    url: wert('--url', ''),
    secs: Number(wert('--secs', '30')),
    label: wert('--label', 'browser'),
    electron: a.includes('--electron'),
  };
}

// Im Browser-Kontext: Offer bauen. Nur recvonly — wir schauen zu.
async function offerBauen() {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });
  window.__pc = pc;
  window.__frames = 0;
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });
  const v = document.createElement('video');
  v.autoplay = true;
  v.muted = true;
  document.body.appendChild(v);
  pc.ontrack = (e) => { v.srcObject = e.streams[0]; };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  // Auf die ICE-Sammlung warten: MediaMTX beantwortet ein Offer ohne
  // Kandidaten zwar, aber die Verbindung käme dann nur über Trickle zustande —
  // und den spricht der WHEP-Weg hier nicht.
  if (pc.iceGatheringState !== 'complete') {
    await new Promise((fertig) => {
      const prüfen = () => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', prüfen);
          fertig();
        }
      };
      pc.addEventListener('icegatheringstatechange', prüfen);
      setTimeout(fertig, 3000);
    });
  }
  return pc.localDescription.sdp;
}

// Im Browser-Kontext: Antwort setzen.
async function antwortSetzen(sdp) {
  await window.__pc.setRemoteDescription({ type: 'answer', sdp });
}

// Im Browser-Kontext: eine Probe. Die Feldnamen sind die von
// RTCInboundRtpStreamStats — `fecPacketsReceived`/`fecPacketsDiscarded` sind
// die beiden, um die es hier geht.
async function probe() {
  const pc = window.__pc;
  const bericht = await pc.getStats();
  const out = { verbindung: pc.connectionState, ice: pc.iceConnectionState };
  bericht.forEach((s) => {
    if (s.type === 'inbound-rtp' && s.kind === 'video') {
      Object.assign(out, {
        framesDecoded: s.framesDecoded, framesDropped: s.framesDropped,
        packetsReceived: s.packetsReceived, packetsLost: s.packetsLost,
        fecPacketsReceived: s.fecPacketsReceived,
        fecPacketsDiscarded: s.fecPacketsDiscarded,
        nackCount: s.nackCount, pliCount: s.pliCount, firCount: s.firCount,
        freezeCount: s.freezeCount, totalFreezesDuration: s.totalFreezesDuration,
        jitter: s.jitter, decoderImplementation: s.decoderImplementation,
        mimeType: s.mimeType,
      });
    }
  });
  return out;
}

async function main() {
  const a = args();
  if (!a.url) {
    console.error('--url fehlt (die WHEP-Adresse samt ?token=)');
    process.exit(2);
  }
  const { chromium, _electron } = ladePlaywright();

  let browser = null;
  let page = null;
  if (a.electron) {
    // Die Electron-Fassung der App: dasselbe Chromium, das Nutzer fahren.
    const app = await _electron.launch({ args: [resolve(HIER, '../../desktop')] });
    page = await app.firstWindow();
    browser = app;
  } else {
    browser = await chromium.launch({
      args: ['--autoplay-policy=no-user-gesture-required'],
    });
    page = await browser.newPage();
    // Irgendeine echte Herkunft; about:blank verbietet manche APIs.
    await page.goto('data:text/html,<html><body></body></html>');
  }

  const proben = [];
  try {
    const offer = await page.evaluate(offerBauen);
    const antwort = await fetch(a.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: offer,
    });
    if (!antwort.ok) {
      console.error(`WHEP-Antwort ${antwort.status} ${antwort.statusText}`);
      process.exit(1);
    }
    const sdp = await antwort.text();

    // DIE Frage: legt Chromium überhaupt einen FlexFEC-Empfänger an?
    const hatFlexfec = /a=rtpmap:\d+ flexfec-03/i.test(sdp);
    const hatFecFr = /a=ssrc-group:FEC-FR/i.test(sdp);
    console.log(`[${a.label}] Antwort: flexfec-03=${hatFlexfec ? 'ja' : 'NEIN'} ` +
                `ssrc-group:FEC-FR=${hatFecFr ? 'ja' : 'NEIN'}`);
    if (hatFlexfec && !hatFecFr) {
      console.log(`[${a.label}] → Chromium wird KEINEN FlexFEC-Empfang anlegen: ` +
                  'der Payload-Type allein genuegt nicht, die SSRC-Gruppe fehlt.');
    }
    writeFileSync(resolve(HIER, `sdp-${a.label}.txt`),
                  `--- OFFER ---\n${offer}\n--- ANSWER ---\n${sdp}\n`);

    await page.evaluate(antwortSetzen, sdp);

    for (let i = 0; i < a.secs; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const p = await page.evaluate(probe);
      proben.push(p);
      if (i === 2 || i === a.secs - 1) {
        console.log(`[${a.label}] t=${i + 1}s ${JSON.stringify(p)}`);
      }
    }
  } finally {
    await browser.close();
  }

  const datei = resolve(HIER, `browser-proben-${a.label}.json`);
  writeFileSync(datei, JSON.stringify(proben, null, 1));

  // Die ersten zwei Sekunden sind Aufbau (ICE, erstes Vollbild) — weglassen,
  // wie beim nativen Prüfstand.
  const gut = proben.slice(2);
  const letzte = gut[gut.length - 1] || {};
  const bilder = (letzte.framesDecoded || 0) - ((gut[0] || {}).framesDecoded || 0);
  console.log(`[${a.label}] ${gut.length} Proben, ${bilder} Bilder dekodiert, ` +
              `fec=${letzte.fecPacketsReceived ?? 'n/a'} ` +
              `verworfen=${letzte.fecPacketsDiscarded ?? 'n/a'} ` +
              `verloren=${letzte.packetsLost ?? 'n/a'} ` +
              `nack=${letzte.nackCount ?? 'n/a'} pli=${letzte.pliCount ?? 'n/a'} ` +
              `decoder=${letzte.decoderImplementation ?? 'n/a'}`);
  console.log(`[${a.label}] SDP in sdp-${a.label}.txt, Proben in ${datei}`);
}

await main();
