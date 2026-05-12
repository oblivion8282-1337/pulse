/**
 * Desktop push-to-talk bridge — currently a no-op stub.
 *
 * Global (system-wide) push-to-talk needs a native key-listener: Electron's
 * `globalShortcut` only fires on press, not press+release, so it can't do
 * hold-to-talk. Until we add a native module for this (e.g. `uiohook-napi`),
 * there is no global PTT — `initDesktopPtt()` returns a no-op disposer.
 *
 * The in-window keyboard PTT in `VoiceChannelView.svelte` (`@svelte-put/shortcut`,
 * key from `settings.voice.pttKey`) is the active PTT path and is unaffected.
 *
 * (Historic: under the old Tauri shell the Rust side registered a global
 * shortcut and emitted `ptt-down` / `ptt-up` events which this module forwarded
 * to the LiveKit voice room. That shell was removed in E1c.)
 */

type Disposer = () => void;

/**
 * Wire up the global push-to-talk shortcut to the voice room.
 *
 * Currently a no-op: returns immediately with a no-op disposer.
 * TODO: global PTT for Electron needs a native key-listener (e.g. uiohook-napi);
 * the in-window PTT in VoiceChannelView still works.
 */
export async function initDesktopPtt(): Promise<Disposer> {
  return () => {};
}
