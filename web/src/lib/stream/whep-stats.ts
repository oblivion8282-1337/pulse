/**
 * Reads `RTCInboundRtpStreamStats` (+ a few extras) off a WHEP
 * `RTCPeerConnection` for both the user-visible overlay (resolution / fps /
 * bitrate) and the diagnostic snapshot we need to debug the AMD-AV1-freeze
 * report.
 *
 * **Freeze detection**: 1 Hz polling, if `framesReceived` keeps increasing
 * but `framesDecoded` does not for >2s, the stream is considered frozen
 * (RTP packets still arriving but the decoder can't make video frames out
 * of them — typical Chromium-libgav1 / VAAPI-decode rejection). A
 * `console.warn` fires once per freeze episode so devtools captures the
 * exact stats at the moment things started to fail.
 *
 * **Micro-stutter detection**: the 2s freeze detector above is deliberately
 * coarse and misses the brief single-frame hitches the user reports. Two
 * finer signals catch those: (1) Chromium's own `freezeCount` — incremented
 * whenever one inter-frame interval blows past `max(3×avg, avg+150ms)`, i.e.
 * exactly a "frame held visibly too long"; a delta here fires a one-shot
 * `console.warn`. (2) `interFrameJitterMs` — the std-dev of decoded
 * inter-frame intervals within the last poll window, derived from
 * `totalInterFrameDelay` / `totalSquaredInterFrameDelay`. ~0 ms = perfectly
 * smooth; a spike is a stutter even when no full `freezeCount` tick landed.
 *
 * Stateful: keeps the previous counters + timestamps across polls. Create
 * one per peer connection; call {@link WhepStatsReader.reset} when the
 * connection is (re)established.
 */

/** Fields shown in the small player overlay. */
export type StreamStats = {
  res: string;
  fps: string;
  bitrate: string;
  /** Codec name parsed from the linked `codec` stats `mimeType` ("video/H264"
   *  → "H.264", "video/AV1" → "AV1"). `'—'` if WebRTC didn't fill the link
   *  yet (typical for the first ~1s after handshake). */
  codec: string;
  /** True iff freeze detector has tripped (framesReceived ↑ but
   *  framesDecoded flat ≥ 2s). Used by the HUD to flag the stats pill red. */
  frozen: boolean;
  /** How long the current freeze has lasted (s); 0 when not frozen. */
  freezeSeconds: number;
  /** Chromium's cumulative `freezeCount` — total number of micro-stutter
   *  hitches the browser flagged since the connection opened. Cheap running
   *  tally for the HUD; a rising value while `frozen` stays false is exactly
   *  the "läuft flüssig, nur manchmal kurzes Stottern"-symptom. */
  microStutters: number;
  /** Full diagnostic snapshot — surfaced via the HUD's copy button. Not
   *  rendered in the overlay; just there so consumers can format/share it. */
  diagnostic: DiagnosticSnapshot;
};

/** All numeric WebRTC stats we read, plus context. Useful for sharing in
 *  bug reports — feed it through {@link formatDiagnostic} for a multi-line
 *  copy-friendly text representation. */
export type DiagnosticSnapshot = {
  framesReceived: number;
  framesDecoded: number;
  keyFramesDecoded: number;
  framesDropped: number;
  pliCount: number;
  firCount: number;
  /** NACK-Pakete, die DIESER Empfänger gesendet hat.
   *
   *  **Das ist NICHT die Zahl der verlorenen Pakete.** Chromium fordert
   *  dieselbe Lücke 6-8x an; roh gemessen war der Zähler um den Faktor 9
   *  aufgebläht (7442 gegen 801 tatsächliche Lücken). Wer ihn als Verlustmaß
   *  liest, misst die Hartnäckigkeit des Empfängers statt den Zustand der
   *  Leitung. Entdoppeln kann nur, wer die Sequenznummern sieht — also der
   *  Server (`scripts/fec-tor-kennzahlen.py`), nicht der Browser.
   *
   *  Das Verlustmaß ist {@link packetsLost}, mit {@link packetsReceived} als
   *  Bezugsgröße. */
  nackCount: number;
  /** Vom Empfänger als verloren gemeldete RTP-Pakete (kumulativ). Das echte
   *  Verlustmaß — anders als `nackCount` zählt es Pakete, nicht Anforderungen.
   *
   *  Kann laut Spezifikation negativ werden (Duplikate/Nachzügler); wir
   *  klemmen nicht, sondern reichen den Wert durch — eine stille Korrektur
   *  auf 0 würde genau den Fall verbergen, in dem etwas nicht stimmt. */
  packetsLost: number;
  /** Empfangene RTP-Pakete (kumulativ). Ohne diese Bezugsgröße ist
   *  `packetsLost` keine Messung: 300 verlorene Pakete sind bei 3000
   *  empfangenen eine Katastrophe und bei 3 Millionen ein Nichts. */
  packetsReceived: number;
  jitter: number | null;
  decoderImplementation: string | null;
  frameWidth: number | null;
  frameHeight: number | null;
  framesPerSecond: number | null;
  bytesReceived: number;
  frozen: boolean;
  freezeSeconds: number;
  /** Cumulative micro-stutter counters from Chromium's stats. `freezeCount`
   *  ticks per brief hitch; `pauseCount` per longer stall. */
  freezeCount: number;
  totalFreezesDuration: number;
  pauseCount: number;
  /** Avg decoded inter-frame interval over the last poll window (ms).
   *  Nominal = 1000 / encode-fps. `null` until two polls are in. */
  interFrameDelayMs: number | null;
  /** Std-dev of the inter-frame interval over the last poll window (ms).
   *  ~0 = smooth; a spike means frames arrived unevenly = micro-stutter. */
  interFrameJitterMs: number | null;
};

type InboundRtp = RTCInboundRtpStreamStats & {
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  framesReceived?: number;
  framesDecoded?: number;
  keyFramesDecoded?: number;
  framesDropped?: number;
  pliCount?: number;
  firCount?: number;
  nackCount?: number;
  packetsLost?: number;
  packetsReceived?: number;
  bytesReceived?: number;
  decoderImplementation?: string;
  freezeCount?: number;
  totalFreezesDuration?: number;
  pauseCount?: number;
  totalPausesDuration?: number;
  totalInterFrameDelay?: number;
  totalSquaredInterFrameDelay?: number;
};

const FREEZE_TRIGGER_SECONDS = 2.0;

export class WhepStatsReader {
  #lastBytes = 0;
  #lastTs = 0;
  #lastFramesReceived = 0;
  #lastFramesDecoded = 0;
  /** monotonic ms of when framesReceived first diverged from framesDecoded;
   *  0 means we are not currently in a divergence streak. */
  #freezeStartedAt = 0;
  /** Set true when we've already console.warned for the current freeze
   *  episode, so we don't spam once per second. Reset when frames decode
   *  again. */
  #warnedThisFreeze = false;
  /** Previous-poll values for the micro-stutter math. */
  #lastFreezeCount = 0;
  #lastInterFrameDelay = 0;
  #lastSquaredInterFrameDelay = 0;

  reset(): void {
    this.#lastBytes = 0;
    this.#lastTs = 0;
    this.#lastFramesReceived = 0;
    this.#lastFramesDecoded = 0;
    this.#freezeStartedAt = 0;
    this.#warnedThisFreeze = false;
    this.#lastFreezeCount = 0;
    this.#lastInterFrameDelay = 0;
    this.#lastSquaredInterFrameDelay = 0;
  }

  async read(pc: RTCPeerConnection): Promise<StreamStats | null> {
    let report: RTCStatsReport;
    try {
      report = await pc.getStats();
    } catch {
      return null;
    }
    let v: InboundRtp | undefined;
    report.forEach((r) => {
      if (r.type === 'inbound-rtp' && (r as RTCInboundRtpStreamStats).kind === 'video') {
        v = r as InboundRtp;
      }
    });
    if (!v) return null;

    const framesReceived = v.framesReceived ?? 0;
    const framesDecoded = v.framesDecoded ?? 0;
    const bytes = v.bytesReceived ?? 0;
    const ts = v.timestamp ?? 0;

    // Bitrate over the delta to the previous poll
    let bitrate = '—';
    if (this.#lastTs > 0 && ts > this.#lastTs) {
      const kbps = ((bytes - this.#lastBytes) * 8) / ((ts - this.#lastTs) / 1000) / 1000;
      bitrate = kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbit/s` : `${Math.round(kbps)} kbit/s`;
    }

    // Freeze detection — comparing against the previous reading.
    const now = performance.now();
    const receivedIncreased = framesReceived > this.#lastFramesReceived;
    const decodedIncreased = framesDecoded > this.#lastFramesDecoded;
    if (this.#lastFramesReceived > 0) {
      if (receivedIncreased && !decodedIncreased) {
        if (this.#freezeStartedAt === 0) this.#freezeStartedAt = now;
      } else if (decodedIncreased) {
        this.#freezeStartedAt = 0;
        this.#warnedThisFreeze = false;
      }
    }
    const freezeSeconds = this.#freezeStartedAt > 0 ? (now - this.#freezeStartedAt) / 1000 : 0;
    const frozen = freezeSeconds >= FREEZE_TRIGGER_SECONDS;

    // Micro-stutter math — finer than the 2s freeze detector above.
    // `totalInterFrameDelay`/`totalSquaredInterFrameDelay` are running sums;
    // the delta over one poll window + the decoded-frame delta give the
    // mean and std-dev of the inter-frame interval inside that window.
    const freezeCount = v.freezeCount ?? 0;
    const interFrameDelay = v.totalInterFrameDelay ?? 0;
    const squaredInterFrameDelay = v.totalSquaredInterFrameDelay ?? 0;
    const havePrev = this.#lastTs > 0;
    const decodedDelta = framesDecoded - this.#lastFramesDecoded;
    let interFrameDelayMs: number | null = null;
    let interFrameJitterMs: number | null = null;
    if (havePrev && decodedDelta > 0) {
      const sumD = interFrameDelay - this.#lastInterFrameDelay;
      const sumD2 = squaredInterFrameDelay - this.#lastSquaredInterFrameDelay;
      const mean = sumD / decodedDelta;
      // Clamp: float drift in the running sums can push this slightly < 0.
      const variance = Math.max(0, sumD2 / decodedDelta - mean * mean);
      interFrameDelayMs = mean * 1000;
      interFrameJitterMs = Math.sqrt(variance) * 1000;
    }
    // A freezeCount tick = Chromium flagged ≥1 visibly-too-long frame this
    // window. Warn once per window so devtools captures the moment.
    const stutterDelta = havePrev ? freezeCount - this.#lastFreezeCount : 0;
    if (stutterDelta > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[whep] micro-stutter ×${stutterDelta}`, {
        interFrameJitterMs: interFrameJitterMs?.toFixed(1),
        interFrameDelayMs: interFrameDelayMs?.toFixed(1),
        networkJitterMs: typeof v.jitter === 'number' ? (v.jitter * 1000).toFixed(1) : null,
        nackCount: v.nackCount ?? 0,
        framesDropped: v.framesDropped ?? 0,
        freezeCount,
      });
    }

    this.#lastTs = ts;
    this.#lastBytes = bytes;
    this.#lastFramesReceived = framesReceived;
    this.#lastFramesDecoded = framesDecoded;
    this.#lastFreezeCount = freezeCount;
    this.#lastInterFrameDelay = interFrameDelay;
    this.#lastSquaredInterFrameDelay = squaredInterFrameDelay;

    const diagnostic: DiagnosticSnapshot = {
      framesReceived,
      framesDecoded,
      keyFramesDecoded: v.keyFramesDecoded ?? 0,
      framesDropped: v.framesDropped ?? 0,
      pliCount: v.pliCount ?? 0,
      firCount: v.firCount ?? 0,
      nackCount: v.nackCount ?? 0,
      packetsLost: v.packetsLost ?? 0,
      packetsReceived: v.packetsReceived ?? 0,
      jitter: typeof v.jitter === 'number' ? v.jitter : null,
      decoderImplementation: v.decoderImplementation ?? null,
      frameWidth: v.frameWidth ?? null,
      frameHeight: v.frameHeight ?? null,
      framesPerSecond: v.framesPerSecond ?? null,
      bytesReceived: bytes,
      frozen,
      freezeSeconds,
      freezeCount,
      totalFreezesDuration: v.totalFreezesDuration ?? 0,
      pauseCount: v.pauseCount ?? 0,
      interFrameDelayMs,
      interFrameJitterMs,
    };

    // First poll of a freeze episode: dump the snapshot to the devtools
    // console so we have the moment-of-failure stats even if the user
    // notices only later and hits the copy button when the picture has
    // already been frozen for a while.
    if (frozen && !this.#warnedThisFreeze) {
      this.#warnedThisFreeze = true;
      // eslint-disable-next-line no-console
      console.warn('[whep] freeze detected', diagnostic);
    }

    // Codec aus dem verlinkten `codec`-Eintrag. RTCRtpCodecStats.mimeType ist
    // immer "video/<NAME>"; H264 für Lesbarkeit zu "H.264" normalisieren.
    let codec = '—';
    if (v.codecId) {
      const c = report.get(v.codecId) as { mimeType?: string } | undefined;
      const sub = c?.mimeType?.split('/')[1];
      if (sub) codec = sub === 'H264' ? 'H.264' : sub;
    }

    return {
      res: v.frameWidth && v.frameHeight ? `${v.frameWidth}×${v.frameHeight}` : '—',
      fps: v.framesPerSecond !== undefined ? `${Math.round(v.framesPerSecond)} fps` : '—',
      bitrate,
      codec,
      frozen,
      freezeSeconds,
      microStutters: freezeCount,
      diagnostic,
    };
  }
}

/** Render a {@link DiagnosticSnapshot} as a multi-line text block. Suitable
 *  for the HUD's "Diagnose kopieren"-button — the user pastes it into the
 *  freeze-report and we get all the numbers we need to localize the layer. */
export function formatDiagnostic(d: DiagnosticSnapshot, ctx?: { name?: string }): string {
  const lines = [
    `# Pulse WHEP diagnostic`,
    `time: ${new Date().toISOString()}`,
    `ua: ${navigator.userAgent}`,
  ];
  if (ctx?.name) lines.push(`stream: ${ctx.name}`);
  // Bezugsgröße einmal ausrechnen statt dreimal in derselben Zeile: sie steht
  // im Text, sie entscheidet über die Prozentangabe, und sie ist deren Nenner.
  const paketeGesamt = d.packetsReceived + d.packetsLost;
  lines.push(
    '',
    `frozen: ${d.frozen ? `yes (${d.freezeSeconds.toFixed(1)}s)` : 'no'}`,
    `resolution: ${d.frameWidth ?? '?'}×${d.frameHeight ?? '?'}`,
    `presentation fps: ${d.framesPerSecond ?? '—'}`,
    `decoder: ${d.decoderImplementation ?? '—'}`,
    `network jitter: ${d.jitter !== null ? `${(d.jitter * 1000).toFixed(1)} ms` : '—'}`,
    '',
    `micro-stutter (freezeCount): ${d.freezeCount}`,
    `freezes total duration: ${d.totalFreezesDuration.toFixed(2)} s`,
    `pauses: ${d.pauseCount}`,
    `inter-frame delay: ${d.interFrameDelayMs !== null ? `${d.interFrameDelayMs.toFixed(1)} ms` : '—'}`,
    `inter-frame jitter: ${d.interFrameJitterMs !== null ? `${d.interFrameJitterMs.toFixed(1)} ms` : '—'}`,
    '',
    `frames received: ${d.framesReceived}`,
    `frames decoded:  ${d.framesDecoded}`,
    `   keyframes:    ${d.keyFramesDecoded}`,
    `   dropped:      ${d.framesDropped}`,
    `bytes received:  ${d.bytesReceived}`,
    '',
    `PLI requests:   ${d.pliCount}`,
    `FIR requests:   ${d.firCount}`,
    // Ausdrücklich als "requests" beschriftet und mit dem Hinweis versehen:
    // die Zahl wird sonst als Verlustmaß gelesen, und das ist sie nicht
    // (Faktor ~9 durch Mehrfachanforderung derselben Lücke).
    `NACK requests:  ${d.nackCount}  (Anforderungen, nicht Verluste — mehrfach je Lücke)`,
    `packets lost:   ${d.packetsLost} von ${paketeGesamt}` +
      (paketeGesamt > 0 ? ` (${((d.packetsLost / paketeGesamt) * 100).toFixed(2)} %)` : ''),
  );
  return lines.join('\n');
}
