import { isMobile } from '$lib/platform/runtime';

/**
 * OS-level MediaSession for an active voice connection.
 *
 * On mobile (Android Chrome / iOS Safari / the Android TWA) a backgrounded
 * tab's audio is only kept alive when the OS sees an ongoing media session
 * anchored to a playing media element. We pair this with the unmuted `<audio>`
 * playback path (see `voice/audioElements.ts` mobile branch) so call audio
 * survives a screen lock instead of going silent after a few seconds.
 *
 * Gated on mobile to avoid hijacking desktop media keys, and a no-op where the
 * API is missing. Best-effort throughout — never throws.
 */
export function setVoiceMediaSession(channelName: string | null): void {
  if (!isMobile()) return;
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  try {
    if (typeof window !== 'undefined' && 'MediaMetadata' in window) {
      ms.metadata = new MediaMetadata({
        title: channelName ?? 'Voice',
        artist: 'Pulse'
      });
    }
    ms.playbackState = 'playing';
    // The OS may decline to keep the session alive without transport handlers.
    // The call keeps running regardless of play/pause taps — both no-op.
    const noop = () => {};
    ms.setActionHandler('play', noop);
    ms.setActionHandler('pause', noop);
  } catch {
    /* MediaSession is a background-keepalive hint; ignore failures. */
  }
}

/** Tear down the voice MediaSession (on disconnect). Safe to call unconditionally. */
export function clearVoiceMediaSession(): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  try {
    ms.playbackState = 'none';
    ms.metadata = null;
    ms.setActionHandler('play', null);
    ms.setActionHandler('pause', null);
  } catch {
    /* ignore */
  }
}
