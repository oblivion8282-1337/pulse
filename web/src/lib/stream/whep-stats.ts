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
  nackCount: number;
  jitter: number | null;
  decoderImplementation: string | null;
  frameWidth: number | null;
  frameHeight: number | null;
  framesPerSecond: number | null;
  bytesReceived: number;
  frozen: boolean;
  freezeSeconds: number;
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
  bytesReceived?: number;
  decoderImplementation?: string;
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

  reset(): void {
    this.#lastBytes = 0;
    this.#lastTs = 0;
    this.#lastFramesReceived = 0;
    this.#lastFramesDecoded = 0;
    this.#freezeStartedAt = 0;
    this.#warnedThisFreeze = false;
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

    this.#lastTs = ts;
    this.#lastBytes = bytes;
    this.#lastFramesReceived = framesReceived;
    this.#lastFramesDecoded = framesDecoded;

    const diagnostic: DiagnosticSnapshot = {
      framesReceived,
      framesDecoded,
      keyFramesDecoded: v.keyFramesDecoded ?? 0,
      framesDropped: v.framesDropped ?? 0,
      pliCount: v.pliCount ?? 0,
      firCount: v.firCount ?? 0,
      nackCount: v.nackCount ?? 0,
      jitter: typeof v.jitter === 'number' ? v.jitter : null,
      decoderImplementation: v.decoderImplementation ?? null,
      frameWidth: v.frameWidth ?? null,
      frameHeight: v.frameHeight ?? null,
      framesPerSecond: v.framesPerSecond ?? null,
      bytesReceived: bytes,
      frozen,
      freezeSeconds,
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
  lines.push(
    '',
    `frozen: ${d.frozen ? `yes (${d.freezeSeconds.toFixed(1)}s)` : 'no'}`,
    `resolution: ${d.frameWidth ?? '?'}×${d.frameHeight ?? '?'}`,
    `presentation fps: ${d.framesPerSecond ?? '—'}`,
    `decoder: ${d.decoderImplementation ?? '—'}`,
    `jitter: ${d.jitter !== null ? `${(d.jitter * 1000).toFixed(1)} ms` : '—'}`,
    '',
    `frames received: ${d.framesReceived}`,
    `frames decoded:  ${d.framesDecoded}`,
    `   keyframes:    ${d.keyFramesDecoded}`,
    `   dropped:      ${d.framesDropped}`,
    `bytes received:  ${d.bytesReceived}`,
    '',
    `PLI requests:   ${d.pliCount}`,
    `FIR requests:   ${d.firCount}`,
    `NACK requests:  ${d.nackCount}`,
  );
  return lines.join('\n');
}
