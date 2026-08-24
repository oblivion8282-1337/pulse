/**
 * Shared `setSinkId` wrapper for every audible sink this app opens outside of
 * LiveKit's own track playback: the two `AudioContext`s (HQ stream via
 * `stream/volumeBoost.ts`, voice channel via `voice/audioElements.ts`) and the
 * `<audio>` elements that back them up. Not supported everywhere
 * (Firefox/Safari/iOS) — silently no-ops there, and on an empty `deviceId`
 * (= "keep the OS default").
 */
type SinkCapable = { setSinkId?: (id: string) => Promise<void> };

export async function applySinkId(
  target: AudioContext | HTMLAudioElement,
  deviceId: string
): Promise<void> {
  if (!deviceId) return;
  const cap = target as unknown as SinkCapable;
  if (typeof cap.setSinkId !== 'function') return;
  try {
    await cap.setSinkId(deviceId);
  } catch {
    /* setSinkId not supported everywhere (Firefox/Safari/iOS). */
  }
}
