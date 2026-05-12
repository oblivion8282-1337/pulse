/**
 * Reads the inbound-video RTP stats off a WHEP `RTCPeerConnection` and formats
 * them as resolution / fps / bitrate strings for the player overlay.
 *
 * Stateful: keeps the previous byte count + timestamp so it can compute the
 * bitrate as a delta between polls. Create one per peer connection; call
 * {@link WhepStatsReader.reset} when the connection is (re)established.
 */

export type StreamStats = { res: string; fps: string; bitrate: string };

export class WhepStatsReader {
  #lastBytes = 0;
  #lastTs = 0;

  reset(): void {
    this.#lastBytes = 0;
    this.#lastTs = 0;
  }

  async read(pc: RTCPeerConnection): Promise<StreamStats | null> {
    let v: RTCInboundRtpStreamStats | undefined;
    try {
      (await pc.getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp' && (r as RTCInboundRtpStreamStats).kind === 'video') {
          v = r as RTCInboundRtpStreamStats;
        }
      });
    } catch {
      return null;
    }
    if (!v) return null;
    const w = (v as { frameWidth?: number }).frameWidth;
    const h = (v as { frameHeight?: number }).frameHeight;
    const fps = (v as { framesPerSecond?: number }).framesPerSecond;
    const bytes = (v as { bytesReceived?: number }).bytesReceived ?? 0;
    const ts = v.timestamp ?? 0;
    let bitrate = '—';
    if (this.#lastTs > 0 && ts > this.#lastTs) {
      const kbps = ((bytes - this.#lastBytes) * 8) / ((ts - this.#lastTs) / 1000) / 1000;
      bitrate = kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbit/s` : `${Math.round(kbps)} kbit/s`;
    }
    this.#lastTs = ts;
    this.#lastBytes = bytes;
    return {
      res: w && h ? `${w}×${h}` : '—',
      fps: fps !== undefined ? `${Math.round(fps)} fps` : '—',
      bitrate,
    };
  }
}
