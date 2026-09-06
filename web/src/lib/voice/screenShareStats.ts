/**
 * Stats-Reader für LiveKit-Screenshare-Tracks.
 *
 * Zwei Lese-Pfade:
 *  - `PublishStatsReader.read(track)` für den eigenen `LocalVideoTrack` →
 *    outbound-rtp; sagt dir zusätzlich, ob der Browser Hardware oder
 *    Software encoded.
 *  - `ReceiveStatsReader.read(track)` für jeden fremden `RemoteVideoTrack` →
 *    inbound-rtp; das ist was *am Empfänger* tatsächlich ankommt.
 *
 * Beide lesen über `track.getRTCStatsReport()` (LiveKit-Public-API), greifen
 * also nicht in interne Pipelines. Stateful für die Bitrate (Delta-Berechnung
 * zwischen zwei Reads) — eine Reader-Instanz pro Track halten und bei
 * Track-Wechsel `.reset()` rufen.
 */

import type { LocalVideoTrack, RemoteVideoTrack } from 'livekit-client';
import { formatBitrate } from '$lib/utils/formatBitrate';

/** Was wir aus `outbound-rtp` + `codec`-Stats für den Streamer rauspulen. */
export type PublishStats = {
  /** "H.264" / "AV1" / "VP9" / "—" wenn das Codec-Link-Feld noch nicht da ist. */
  codec: string;
  /** "1920×1080" oder "—". `frameWidth`/`frameHeight` liefert WebRTC erst nach
   *  dem ersten encodeten Frame. */
  res: string;
  /** "30 fps" oder "—". Das ist die *Sende*-Framerate, kann unter dem im UI
   *  konfigurierten Wert liegen (Capture-Source liefert weniger, oder der
   *  Browser dropped Frames weil der Encoder nicht hinterherkommt). */
  fps: string;
  /** Berechnet aus dem `bytesSent`-Delta zwischen zwei Reads. */
  bitrate: string;
  /** Rohwert von `encoderImplementation` — z.B. "ExternalEncoder",
   *  "OpenH264", "libaom", "MediaFoundation_h264". Roh angezeigt im Tooltip
   *  damit man bei merkwürdigen Strings noch was zum Googeln hat. */
  encoderImpl: string;
  /** Heuristisch aus `encoderImpl` abgeleitet: Hardware (GPU), Software (CPU),
   *  oder unknown wenn der String nicht zuordbar ist. */
  encoderKind: 'gpu' | 'cpu' | 'unknown';
};

/** Was wir für den Zuschauer aus `inbound-rtp` + `codec`-Stats rauspulen. */
export type ReceiveStats = {
  codec: string;
  res: string;
  fps: string;
  bitrate: string;
};

type OutboundRtp = RTCOutboundRtpStreamStats & {
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  bytesSent?: number;
  encoderImplementation?: string;
};

type InboundRtp = RTCInboundRtpStreamStats & {
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  bytesReceived?: number;
};

/** Encoder-Implementation-Strings, die der WebRTC-Spec keine harte Form
 *  vorschreibt — hier eine Heuristik gegen die Strings die Chrome/Firefox/
 *  Safari in der Praxis ausliefern. Nicht erschöpfend; alles unbekannte
 *  rutscht in `unknown` und zeigt den Rohwert. */
const HW_ENCODER_HINTS = [
  // Chrome generic — der Wrapper-String wenn der WebRTC-Stack einen HW-Encoder
  // findet, OHNE den konkreten Backend-Namen rauszugeben.
  'externalencoder',
  // Windows hardware encoders (Chrome ≥ M118 nennt sie meist beim Namen)
  'mediafoundation',
  'd3d11',
  'nvenc',
  'nv_encoder',
  'qsv',
  'quicksync',
  'amf',
  // macOS
  'videotoolbox',
  // Linux
  'vaapi',
  'v4l2',
  // Generic flag occasionally
  'hardware'
];
const SW_ENCODER_HINTS = [
  'openh264',  // H.264 SW reference encoder (Cisco)
  'libvpx',    // VP8/VP9 SW
  'libaom',    // AV1 SW
  'svtav1',    // newer AV1 SW
  'software'
];

function classifyEncoder(impl: string | undefined): 'gpu' | 'cpu' | 'unknown' {
  if (!impl) return 'unknown';
  const s = impl.toLowerCase();
  // SW kommt zuerst dran — Strings wie "External" können in beide passen,
  // aber "openh264" gewinnt eindeutig.
  if (SW_ENCODER_HINTS.some((h) => s.includes(h))) return 'cpu';
  if (HW_ENCODER_HINTS.some((h) => s.includes(h))) return 'gpu';
  return 'unknown';
}

function codecNameFrom(report: RTCStatsReport, codecId: string | undefined): string {
  if (!codecId) return '—';
  const c = report.get(codecId) as { mimeType?: string } | undefined;
  const sub = c?.mimeType?.split('/')[1];
  if (!sub) return '—';
  return sub === 'H264' ? 'H.264' : sub;
}

function formatRes(w: number | undefined, h: number | undefined): string {
  return w && h ? `${w}×${h}` : '—';
}

function formatFps(fps: number | undefined): string {
  return typeof fps === 'number' ? `${Math.round(fps)} fps` : '—';
}


export class PublishStatsReader {
  #lastBytes = 0;
  #lastTs = 0;

  reset(): void {
    this.#lastBytes = 0;
    this.#lastTs = 0;
  }

  async read(track: LocalVideoTrack | undefined | null): Promise<PublishStats | null> {
    if (!track) return null;
    let report: RTCStatsReport | undefined;
    try {
      report = await track.getRTCStatsReport();
    } catch {
      return null;
    }
    if (!report) return null;
    let o: OutboundRtp | undefined;
    report.forEach((r) => {
      if (r.type === 'outbound-rtp' && (r as RTCOutboundRtpStreamStats).kind === 'video') {
        // Bei Simulcast kommen mehrere outbound-rtps zurück; den mit den
        // meisten gesendeten Bytes nehmen (das ist die aktive Layer).
        const cand = r as OutboundRtp;
        if (!o || (cand.bytesSent ?? 0) > (o.bytesSent ?? 0)) o = cand;
      }
    });
    if (!o) return null;

    const bytes = o.bytesSent ?? 0;
    const ts = o.timestamp ?? 0;
    let bitrate = '—';
    if (this.#lastTs > 0 && ts > this.#lastTs) {
      bitrate = formatBitrate(bytes - this.#lastBytes, ts - this.#lastTs);
    }
    this.#lastTs = ts;
    this.#lastBytes = bytes;

    const encoderImpl = o.encoderImplementation ?? '';
    return {
      codec: codecNameFrom(report, o.codecId),
      res: formatRes(o.frameWidth, o.frameHeight),
      fps: formatFps(o.framesPerSecond),
      bitrate,
      encoderImpl,
      encoderKind: classifyEncoder(encoderImpl)
    };
  }
}

export class ReceiveStatsReader {
  #lastBytes = 0;
  #lastTs = 0;

  reset(): void {
    this.#lastBytes = 0;
    this.#lastTs = 0;
  }

  async read(track: RemoteVideoTrack | undefined | null): Promise<ReceiveStats | null> {
    if (!track) return null;
    let report: RTCStatsReport | undefined;
    try {
      report = await track.getRTCStatsReport();
    } catch {
      return null;
    }
    if (!report) return null;
    let v: InboundRtp | undefined;
    report.forEach((r) => {
      if (r.type === 'inbound-rtp' && (r as RTCInboundRtpStreamStats).kind === 'video') {
        v = r as InboundRtp;
      }
    });
    if (!v) return null;

    const bytes = v.bytesReceived ?? 0;
    const ts = v.timestamp ?? 0;
    let bitrate = '—';
    if (this.#lastTs > 0 && ts > this.#lastTs) {
      bitrate = formatBitrate(bytes - this.#lastBytes, ts - this.#lastTs);
    }
    this.#lastTs = ts;
    this.#lastBytes = bytes;

    return {
      codec: codecNameFrom(report, v.codecId),
      res: formatRes(v.frameWidth, v.frameHeight),
      fps: formatFps(v.framesPerSecond),
      bitrate
    };
  }
}
