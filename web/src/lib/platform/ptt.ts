/**
 * Desktop push-to-talk bridge.
 *
 * Under Tauri, the Rust side registers a global shortcut (default `Alt+Space`,
 * see `desktop/src-tauri/src/ptt.rs`) and emits `ptt-down` / `ptt-up` events.
 * This module forwards those to the LiveKit voice room — the same hooks the
 * in-window keyboard PTT in `VoiceChannelView.svelte` uses (`voice.pttPress()`
 * / `voice.pttRelease()`), which are no-ops unless PTT mode is on and we're
 * connected.
 *
 * In a plain browser this module does nothing: `initDesktopPtt()` returns a
 * no-op disposer, so the existing browser PTT path is completely untouched.
 */

import { isTauri } from './runtime';

type Disposer = () => void;

/**
 * Wire the Tauri global-shortcut PTT events to the voice room. Idempotent in
 * spirit (callers should still avoid registering twice). Returns a disposer
 * that detaches the listeners. No-op (returns immediately) outside Tauri.
 */
export async function initDesktopPtt(): Promise<Disposer> {
  if (!isTauri()) return () => {};

  const { listen } = await import('@tauri-apps/api/event');

  // Lazily pull in the voice module on first use so the browser bundle doesn't
  // eagerly load livekit-client just because this ran.
  const voiceMod = () => import('$lib/voice/livekit.svelte');

  const unlistenDown = await listen('ptt-down', () => {
    void voiceMod().then(({ voice }) => voice.pttPress());
  });
  const unlistenUp = await listen('ptt-up', () => {
    void voiceMod().then(({ voice }) => voice.pttRelease());
  });

  return () => {
    unlistenDown();
    unlistenUp();
  };
}
