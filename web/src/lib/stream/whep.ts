/**
 * Minimal WHEP (WebRTC-HTTP Egress Protocol, `draft-ietf-wish-whep`) client —
 * just enough to play back a MediaMTX HQ stream. Hand-rolled (~120 lines) on
 * purpose: a dependency would be heavier than the protocol itself.
 *
 * Flow (non-trickle, the simplest variant MediaMTX 1.18 supports):
 *  1. `RTCPeerConnection`, `addTransceiver('video'|'audio', recvonly)`.
 *  2. `createOffer()` → `setLocalDescription()` → wait for ICE gathering to
 *     complete (with a short timeout fallback) so the offer carries all
 *     candidates.
 *  3. `POST <whepUrl>` with `Content-Type: application/sdp`, body = the offer
 *     SDP. A 201 response carries the answer SDP in the body and the resource
 *     URL in the `Location` header.
 *  4. `setRemoteDescription({type:'answer', sdp})`.
 *  5. On teardown: `pc.close()` + best-effort `DELETE <resourceUrl>`.
 *
 * Reference for the mechanics: `~/Dokumente/GPU_Screen_Recorder/server/player.html`
 * (a working WHEP player against this exact MediaMTX). We don't copy it; we
 * follow the pattern. Note: the WHEP URL returned by the gateway already
 * carries a `?token=` read token (minted after the membership/VIEW_CHANNEL
 * check) — we pass the URL through verbatim; MediaMTX forwards the token to the
 * auth-hook, which rejects anonymous reads.
 */

/** Public STUN — MediaMTX with host networking usually doesn't need it, but
 *  it's harmless and helps when the viewer is behind NAT. Mirrors player.html. */
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/** Max time to wait for ICE gathering before POSTing the offer anyway. */
const ICE_GATHERING_TIMEOUT_MS = 2000;

/**
 * Wieviel Vorlauf der Empfänger sammeln soll, bevor er ein Bild zeichnet.
 *
 * **Warum überhaupt etwas gesetzt wird.** Ohne Angabe zielt Chromiums
 * Jitter-Puffer auf minimale Verzögerung und zeichnet praktisch bei Ankunft.
 * Bilder kommen aber nie gleichmäßig an — und jede Ankunftsschwankung wird
 * damit unmittelbar zu sichtbarem Ruckeln. Bei 60 fps ist das Zeitfenster je
 * Bild nur 16,7 ms; die am 2026-07-28 über die echte Leitung gemessenen
 * Ankunftslücken lagen bei 25-74 ms, also ein Vielfaches davon. Ein kleiner
 * Vorrat fängt genau das ab: kommt ein Bild verspätet, ist es trotzdem
 * rechtzeitig da, weil die Anzeige ohnehin etwas hinterherläuft.
 *
 * **Warum 120 ms.** Über der gemessenen NACK-Nachlieferzeit (~61 ms, s.
 * `pulse-player/src/proto.rs`) — ein per Nachlieferung gerettetes Paket soll
 * seinen Anzeigetermin noch schaffen, sonst war die Rettung umsonst. Und
 * klein genug, dass beim Zuschauen niemand die Verzögerung bemerkt.
 *
 * **Wo das NICHT gilt:** die Fernsteuerung. Sie läuft über den nativen Player
 * (`streaming/pulse-player/`), der seinen Vorhalt im Fern-Modus bewusst auf
 * 5 ms senkt — dort ist jede Millisekunde zwischen Eingabe und Bild spürbar,
 * und Glätte ist der falsche Tausch. Diese Datei bedient nur die
 * Zuschauer-Kachel im Browser; wer sie je für einen Steuerweg mitbenutzt,
 * muss den Wert dort auf 0 setzen.
 */
const JITTER_BUFFER_TARGET_MS = 120;

/**
 * Ask for STEREO Opus in the offer's fmtp line.
 *
 * Without this, Chrome offers `a=fmtp:111 minptime=10;useinbandfec=1` — no
 * `stereo=1` — and per RFC 7587 the decoder then renders MONO. The publisher's
 * stereo Opus packets arrive fine; the viewer just downmixes them. Measured
 * 2026-07-16 against a left-only source (HLS: L −21 dB / R −293 dB): WHEP
 * delivered L=R=0.0442, i.e. exactly `(L+R)/2`.
 *
 * `stereo=1` = "I want stereo rendered"; `sprop-stereo=1` = "expect stereo on
 * the wire" (a hint that lets the decoder size itself right from the start).
 * Both are receiver-side preferences and safe: a mono publisher stays mono,
 * Opus signals the real channel count per packet.
 *
 * Why string surgery instead of `setCodecPreferences`: that API picks WHICH
 * codec, not its fmtp parameters — there is no non-munging way to set this.
 */
function preferStereoOpus(sdp: string): string {
  // Resolve Opus' payload type(s) from rtpmap rather than guessing from the
  // fmtp params — the PT is dynamic (111 today, but that's not guaranteed).
  const opusPts = new Set(
    [...sdp.matchAll(/^a=rtpmap:(\d+) opus\/\d+(?:\/\d+)?$/gim)].map((m) => m[1]),
  );
  if (opusPts.size === 0) return sdp;

  const lines = sdp.split('\r\n');
  const patched = lines.map((line) => {
    const m = /^a=fmtp:(\d+) (.*)$/.exec(line);
    if (!m || !opusPts.has(m[1]) || /(?:^|;)stereo=/.test(m[2])) return line;
    return `a=fmtp:${m[1]} ${m[2]};stereo=1;sprop-stereo=1`;
  });
  // Opus without any fmtp line at all: add one, else the preference is lost.
  for (const pt of opusPts) {
    if (patched.some((l) => l.startsWith(`a=fmtp:${pt} `))) continue;
    const idx = patched.findIndex((l) => new RegExp(`^a=rtpmap:${pt} opus/`, 'i').test(l));
    if (idx >= 0) patched.splice(idx + 1, 0, `a=fmtp:${pt} stereo=1;sprop-stereo=1`);
  }
  return patched.join('\r\n');
}

export class WhepError extends Error {
  /** HTTP status if the failure came from the WHEP POST, else 0. */
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'WhepError';
    this.status = status;
  }
}

export interface WhepSession {
  pc: RTCPeerConnection;
  /** Resource URL from the 201 `Location` header (for DELETE on teardown). */
  resourceUrl: string | null;
  /** Tear down: close the peer connection + best-effort DELETE the resource. */
  close(): Promise<void>;
}

async function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return;
  await new Promise<void>((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      pc.removeEventListener('icecandidate', onCandidate);
      clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    // A server-reflexive (STUN) candidate is the one a remote viewer actually
    // needs to reach the MediaMTX host candidate through NAT; once we have it
    // there's no point waiting for the full gathering to finish (the remaining
    // host-only LAN candidates don't help a remote peer). This cuts the fixed
    // pre-POST delay from the 2 s cap to a few hundred ms on a healthy network,
    // while the timeout still bounds the worst case.
    const onCandidate = (e: RTCPeerConnectionIceEvent) => {
      if (e.candidate?.type === 'srflx') done();
    };
    const timer = setTimeout(done, ICE_GATHERING_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', onChange);
    pc.addEventListener('icecandidate', onCandidate);
  });
}

function resolveResourceUrl(whepUrl: string, location: string | null): string | null {
  if (!location) return null;
  try {
    const resolved = new URL(location, whepUrl);
    // Only follow the resource URL if it shares the same origin as the WHEP
    // endpoint — prevents an attacker-controlled or misconfigured Location
    // header from redirecting the teardown DELETE to an unrelated host.
    if (resolved.origin !== new URL(whepUrl).origin) return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

/**
 * Establish a WHEP recv-only session against `whepUrl`.
 *
 * `onTrack` receives the inbound `MediaStream` (attach it to a `<video>`).
 * Throws {@link WhepError} on transport / HTTP / SDP failures — the caller
 * decides whether to retry (e.g. on 404 = publisher not online yet).
 */
export async function connectWhep(
  whepUrl: string,
  onTrack: (stream: MediaStream) => void,
  iceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS
): Promise<WhepSession> {
  const pc = new RTCPeerConnection({ iceServers });
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });
  let trackReceived = false;
  let syntheticStream: MediaStream | null = null;
  pc.ontrack = (e) => {
    if (e.streams[0]) {
      // Standard path: track already bound to a stream — use it on first event.
      if (!trackReceived) {
        trackReceived = true;
        onTrack(e.streams[0]);
      }
      return;
    }
    // Fallback path: no stream association (non-standard peer). Accumulate all
    // tracks into one synthetic stream; fire the callback only on the first track.
    if (!syntheticStream) {
      syntheticStream = new MediaStream();
    }
    syntheticStream.addTrack(e.track);
    if (!trackReceived) {
      trackReceived = true;
      onTrack(syntheticStream);
    }
  };

  let resourceUrl: string | null = null;
  const session: WhepSession = {
    pc,
    get resourceUrl() {
      return resourceUrl;
    },
    async close() {
      try {
        pc.close();
      } catch {
        /* already closed */
      }
      if (resourceUrl) {
        try {
          await fetch(resourceUrl, { method: 'DELETE' });
        } catch {
          /* best effort — the server times the resource out anyway */
        }
        resourceUrl = null;
      }
    }
  };

  try {
    const offer = await pc.createOffer();
    // VOR setLocalDescription mungen — nicht danach. Die fmtp-Parameter der
    // LOKALEN Description konfigurieren libwebrtcs Opus-DECODER; munget man
    // erst den ausgehenden Body, sieht der Server zwar `stereo=1`, der eigene
    // Decoder läuft aber weiter mono (2026-07-16 gemessen: getStats() meldete
    // `minptime=10;useinbandfec=1` und L==R, obwohl Angebot UND Antwort
    // `stereo=1` trugen).
    offer.sdp = preferStereoOpus(offer.sdp ?? '');
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);
    const sdp = pc.localDescription?.sdp ?? offer.sdp ?? '';

    let res: Response;
    try {
      res = await fetch(whepUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: sdp
      });
    } catch (netErr) {
      throw new WhepError(
        `WHEP server unreachable: ${netErr instanceof Error ? netErr.message : String(netErr)}`
      );
    }
    if (!res.ok) {
      throw new WhepError(`WHEP POST failed: HTTP ${res.status} ${res.statusText}`, res.status);
    }
    // Headers.get() is case-insensitive per the Fetch spec, so 'Location' also matches 'location'.
    resourceUrl = resolveResourceUrl(whepUrl, res.headers.get('Location'));
    const answer = await res.text();
    if (!answer.includes('v=')) {
      throw new WhepError('WHEP answer was not valid SDP');
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    // ERST hier setzen, nicht beim addTransceiver: vor der Antwort trägt der
    // Receiver noch keinen ausgehandelten Codec, und Chromium verwirft den
    // Wunsch dann still. Die Eigenschaft ist zudem nicht überall vorhanden
    // (ältere Browser, Firefox) — sie fehlend zu finden ist kein Fehler,
    // sondern heißt: dieser Zuschauer bekommt eben das Vorverhalten.
    for (const r of pc.getReceivers()) {
      if (r.track?.kind !== 'video') continue;
      try {
        if ('jitterBufferTarget' in r) {
          (r as RTCRtpReceiver & { jitterBufferTarget: number | null }).jitterBufferTarget =
            JITTER_BUFFER_TARGET_MS;
        }
      } catch {
        /* Browser mag den Wert nicht — Vorverhalten ist gut genug */
      }
    }
  } catch (e) {
    await session.close();
    throw e;
  }
  return session;
}
