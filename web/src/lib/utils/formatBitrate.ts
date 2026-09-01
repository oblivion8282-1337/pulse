/** Bitrate aus Byte/ms-Deltas, menschlich gerundet — geteilt von den
 *  Voice-Screen-Share-Stats und den WHEP-Stream-Stats. */
export function formatBitrate(deltaBytes: number, deltaMs: number): string {
  if (deltaMs <= 0) return '—';
  const kbps = (deltaBytes * 8) / (deltaMs / 1000) / 1000;
  if (!Number.isFinite(kbps) || kbps < 0) return '—';
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbit/s` : `${Math.round(kbps)} kbit/s`;
}
