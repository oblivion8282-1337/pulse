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
  // Mehrfach angebbar: `--env A=1 --env B=2`.
  const alleWerte = (name) =>
    a.flatMap((v, i) => (v === name && a[i + 1] ? [a[i + 1]] : []));
  return {
    // Zusaetzliche Chromium-Schalter, komma-getrennt, ohne Leerzeichen:
    //   --flags "--enable-features=AcceleratedVideoDecodeLinuxGL,--ignore-gpu-blocklist"
    // Getrennt wird an Kommas, denen ein `--` folgt — sonst zerrisse es die
    // Feature-Liste INNERHALB von `--enable-features=A,B` in zwei Schalter.
    flags: wert('--flags', '')
      .split(/,(?=--)/)
      .map((s) => s.trim())
      .filter(Boolean),
    // Umgebung fuer den Browser-Prozess, z.B. `--env LIBVA_DRIVER_NAME=nvidia`.
    // Muss VOR dem Start gesetzt sein: libva liest sie beim Initialisieren.
    env: Object.fromEntries(
      alleWerte('--env').map((p) => {
        const i = p.indexOf('=');
        return i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)];
      }),
    ),
    url: wert('--url', ''),
    secs: Number(wert('--secs', '30')),
    label: wert('--label', 'browser'),
    electron: a.includes('--electron'),
    // Sichtbares Fenster statt headless — zum ZUSEHEN, nicht zum Messen.
    // Achtung fuer Messungen: ein sichtbarer Chromium dekodiert ueber die
    // GPU, ein headless ueber die Software-Anbindung. Das ist genau der
    // Unterschied, an dem AV1 10 bit haengt.
    sichtbar: a.includes('--sichtbar'),
    // Ton hoerbar ausgeben — nur fuer Tonlaufzeit-Messungen (s. offerBauen).
    ton: a.includes('--ton'),
    // Bezugspunkt fuer den Zeitmuster-Balken (ms seit Epoche), wie
    // `PULSE_PLAYER_LATENCY_EPOCH_MS` beim Player. Ohne ihn keine Bildmessung.
    epoch: Number(wert('--epoch', '0')),
    // X-Position des Fensters; muss auf einem ANDEREN Schirm liegen als das
    // Zeitmuster (s. Launch-Argumente).
    fensterX: Number(wert('--fenster-x', '0')),
  };
}

// Im Browser-Kontext: Offer bauen. Nur recvonly — wir schauen zu.
async function offerBauen({ ton } = { ton: false }) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });
  window.__pc = pc;
  window.__frames = 0;
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });
  const v = document.createElement('video');
  v.autoplay = true;
  // Stumm ist die Vorgabe: fuer Bildmessungen ist der Ton nur eine Fehlerquelle
  // (er zieht Interleaving und Puffer mit hinein). `--ton` schaltet ihn frei,
  // wenn die TONlaufzeit die Messgroesse ist — dann muss der Browser hoerbar
  // ausgeben, sonst gibt es nichts aufzunehmen. Autoplay ohne Nutzergeste ist
  // beim Start bereits erlaubt (`--autoplay-policy`), sonst bliebe es trotz
  // `muted = false` still.
  v.muted = !ton;
  v.volume = 1.0;
  // Fensterfuellend und schwarz hinterlegt: ohne das ist das Element im
  // sichtbaren Fenster winzig und man sieht nichts vom Bild.
  document.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
  v.style.cssText = 'width:100vw;height:100vh;object-fit:contain;display:block';
  document.body.appendChild(v);
  window.__video = v;
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

// Im Browser-Kontext: welcher GL-Treiber liegt wirklich darunter?
//
// UNVERZICHTBARE KONTROLLE fuer jede Decode-Messung: Playwright startet sein
// Chromium unter anderem mit `--enable-unsafe-swiftshader`. Faellt es dabei auf
// SwiftShader (Software-GL) zurueck, kann ueber die GPU gar nichts dekodiert
// werden — ein Ergebnis "Software" waere dann schon in den Aufbau gelegt und
// wuerde ueber den Auslieferzustand nichts aussagen. Steht hier ein echter
// NVIDIA/AMD/Intel-Name, hatte der Browser Zugriff auf die Karte.
function gpuAuskunft() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return 'kein WebGL';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch (e) {
    return `Fehler: ${String(e).slice(0, 60)}`;
  }
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

  // Fingerabdruck des SICHTBAREN Bildes.
  //
  // WARUM ZUSAETZLICH ZU framesDecoded: Am 2026-07-31 lieferte der native
  // Player 60 Bilder je Sekunde und zeigte trotzdem ein Standbild — der
  // Decoder gab immer dasselbe Bild aus. Kein Zaehler meldete das, auch
  // `freezeCount` nicht, denn formal kamen ja Bilder. Nur ein Blick auf die
  // Pixel entscheidet, ob sich das Bild wirklich aendert.
  //
  // Kleines Ziel-Canvas (64x36): Es geht um "hat sich etwas geaendert", nicht
  // um Bildqualitaet. Das Herunterskalieren macht die GPU, es kostet fast
  // nichts, und es glaettet Kodierrauschen weg, das sonst jeden Vergleich
  // verrauschen wuerde.
  // Zeitmuster-Balken lesen — dasselbe Format wie `pulse-player/src/probe.rs`
  // und `testbench/pattern_format.py`. Ohne das misst der Browser-Weg gar
  // keine Bildlaufzeit: der Player liest den Balken aus dem dekodierten Bild,
  // fuer Chromium gab es bisher nur den Umweg ueber ein Bildschirmfoto, das
  // Compositor und Anzeigeverzug mitzaehlt. So messen jetzt beide dasselbe.
  try {
    const v = window.__video;
    if (v && v.videoWidth > 0 && window.__epoch) {
      const BLOCK = 32, MARKER = [1, 0, 1, 1, 0, 0, 1, 0], BITS = 16;
      const POS_X = [64, 880, 1696], POS_Y = [64, 400, 800, 1200];
      const c = window.__barCanvas || (window.__barCanvas = document.createElement('canvas'));
      c.width = v.videoWidth; c.height = v.videoHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(v, 0, 0);
      // **Die ganze Balkenzeile in EINEM Zug holen.** Ein `getImageData` je
      // Bit waeren bis zu 288 Aufrufe pro Probe (24 Bit x 12 Stellen), jeder
      // mit GPU-Synchronisierung — im ersten Versuch kam davon 1 von 41 Proben
      // durch. Eine Zeile pro Stelle genuegt, die Klotzmitten stehen darin.
      const breite = (MARKER.length + BITS) * BLOCK;
      const leseBalken = (x0, y0) => {
        const y = y0 + BLOCK / 2;
        if (y >= c.height || x0 + breite > c.width) return null;
        const d = ctx.getImageData(x0, y, breite, 1).data;
        // Grenzwerte wie im Player: dazwischen liegt kein gueltiger Wert, und
        // ein grauer Punkt heisst "das ist nicht unser Balken".
        const bitAt = (i) => {
          const o = (i * BLOCK + BLOCK / 2) * 4;
          const luma = 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];
          if (luma <= 70) return 0;
          if (luma >= 180) return 1;
          return null;
        };
        for (let i = 0; i < MARKER.length; i++) {
          if (bitAt(i) !== MARKER[i]) return null;
        }
        let zaehler = 0;
        for (let i = 0; i < BITS; i++) {
          const b = bitAt(MARKER.length + i);
          if (b === null) return null;
          zaehler = (zaehler << 1) | b;
        }
        return zaehler;
      };
      let zaehler = null;
      const treffer = window.__barHit;
      if (treffer) zaehler = leseBalken(treffer[0], treffer[1]);
      if (zaehler === null) {
        for (const y0 of POS_Y) {
          for (const x0 of POS_X) {
            const z = leseBalken(x0, y0);
            if (z !== null) { zaehler = z; window.__barHit = [x0, y0]; break; }
          }
          if (zaehler !== null) break;
        }
      }
      out.musterLatenzMs = zaehler === null
        ? null
        : ((Date.now() - window.__epoch) - zaehler) & 0xFFFF;
    }
  } catch (e) {
    out.musterFehler = String(e).slice(0, 80);
  }

  try {
    const v = window.__video;
    if (v && v.videoWidth > 0) {
      const c = window.__canvas || (window.__canvas = document.createElement('canvas'));
      c.width = 64; c.height = 36;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(v, 0, 0, 64, 36);
      const d = ctx.getImageData(0, 0, 64, 36).data;
      let h = 2166136261;
      for (let i = 0; i < d.length; i += 4) {
        h ^= d[i]; h = Math.imul(h, 16777619);
      }
      out.bildAbdruck = h >>> 0;
    }
  } catch (e) {
    out.bildAbdruckFehler = String(e).slice(0, 80);
  }
  bericht.forEach((s) => {
    if (s.type === 'inbound-rtp' && s.kind === 'video') {
      Object.assign(out, {
        framesDecoded: s.framesDecoded, framesDropped: s.framesDropped,
        framesReceived: s.framesReceived, framesAssembled: s.framesAssembledFromMultiplePackets,
        keyFramesDecoded: s.keyFramesDecoded, frameWidth: s.frameWidth, frameHeight: s.frameHeight,
        packetsReceived: s.packetsReceived, packetsLost: s.packetsLost,
        fecPacketsReceived: s.fecPacketsReceived,
        fecPacketsDiscarded: s.fecPacketsDiscarded,
        nackCount: s.nackCount, pliCount: s.pliCount, firCount: s.firCount,
        freezeCount: s.freezeCount, totalFreezesDuration: s.totalFreezesDuration,
        jitter: s.jitter, decoderImplementation: s.decoderImplementation,
        mimeType: s.mimeType,
        // DIE drei Felder fuer die Frage "Hardware oder Software?".
        //
        // `powerEfficientDecoder` ist das einzige, das libwebrtc SELBST als
        // Ja/Nein beantwortet — `decoderImplementation` ist nur ein Name, und
        // der luegt bekanntermassen: er meldet gern eine
        // Hardware-Implementierung, waehrend der Decode still in Software
        // zurueckfaellt (genau die Falle, wegen der `VaapiIgnoreDriverChecks`
        // ueberhaupt existiert). Deshalb wird beides erhoben, und die GPU-Last
        // daneben entscheidet im Zweifel.
        powerEfficientDecoder: s.powerEfficientDecoder,
        // Rechenzeit je Bild (totalDecodeTime/framesDecoded) ist die dritte,
        // von den anderen beiden unabhaengige Achse: Software-AV1 bei 1440p
        // kostet ein Vielfaches von NVDEC und faellt auch dann auf, wenn beide
        // Selbstauskuenfte oben irren.
        totalDecodeTime: s.totalDecodeTime,
        totalInterFrameDelay: s.totalInterFrameDelay,
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
  const umgebung = Object.keys(a.env).length ? { ...process.env, ...a.env } : undefined;
  if (a.electron) {
    // Die Electron-Fassung der App: dasselbe Chromium, das Nutzer fahren.
    //
    // `--flags` landen hier HINTER dem Verzeichnis, also als Argumente der App
    // — Electron reicht unbekannte Schalter an Chromium durch. Damit laesst
    // sich messen, was zusaetzliche Schalter braechten, OHNE `main.ts`
    // anzufassen; der Auslieferzustand ist schlicht der Lauf ohne `--flags`.
    const app = await _electron.launch({
      args: [resolve(HIER, '../../desktop'), ...a.flags],
      env: umgebung,
    });
    page = await app.firstWindow();
    browser = app;
  } else {
    browser = await chromium.launch({
      headless: !a.sichtbar,
      env: umgebung,
      args: [
        '--autoplay-policy=no-user-gesture-required',
        ...a.flags,
        // **Weg vom aufgenommenen Bildschirm.** Liegt das Fenster auf dem
        // Schirm, den der Sender aufnimmt, verdeckt es das Zeitmuster und
        // erzeugt eine Rueckkopplung — die Messung liest dann entweder gar
        // keinen Balken oder einen bereits uebertragenen (zu kleine Latenz).
        `--window-position=${a.fensterX},0`,
      ],
    });
    page = await browser.newPage();
    // Irgendeine echte Herkunft; about:blank verbietet manche APIs.
    await page.goto('data:text/html,<html><body></body></html>');
  }

  const proben = [];
  try {
    console.log(`[${a.label}] GL-Treiber: ${await page.evaluate(gpuAuskunft)}`);
    const offer = await page.evaluate(offerBauen, { ton: a.ton });
    await page.evaluate((e) => { window.__epoch = e; }, a.epoch);
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
      // Wanduhr an jeder Probe. Ohne sie lassen sich zwei GLEICHZEITIG
      // laufende Zuschauer nicht gegeneinander legen — man muss die
      // Probennummern aufeinander schaetzen, und genau daran ist die erste
      // Auswertung des Zwei-Zuschauer-Laufs (2026-08-04) haengengeblieben.
      p.t = Date.now();
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
  // Decode-Zeit je Bild aus der DIFFERENZ ueber den Lauf, nicht aus dem
  // Endstand geteilt durch alle Bilder: die ersten Bilder nach dem Verbinden
  // sind teurer (Decoder-Aufbau) und zoegen einen Gesamtschnitt nach oben.
  const ersteGute = gut[0] || {};
  const dtSpanne = (letzte.totalDecodeTime ?? 0) - (ersteGute.totalDecodeTime ?? 0);
  const msJeBild = bilder > 0 ? (dtSpanne * 1000) / bilder : null;
  console.log(`[${a.label}] sparsamerDecoder=${letzte.powerEfficientDecoder ?? 'n/a'} ` +
              `decodeZeit=${msJeBild === null ? 'n/a' : msJeBild.toFixed(2) + ' ms/Bild'} ` +
              `codec=${letzte.mimeType ?? 'n/a'} ` +
              `${letzte.frameWidth ?? '?'}x${letzte.frameHeight ?? '?'}`);
  console.log(`[${a.label}] SDP in sdp-${a.label}.txt, Proben in ${datei}`);
}

await main();
