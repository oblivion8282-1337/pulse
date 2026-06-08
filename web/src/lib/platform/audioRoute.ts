/**
 * Native audio-output routing (Capacitor Android wrapper only).
 *
 * The APK loads the web app remotely; Capacitor injects a native bridge so the
 * remote page can call the `AudioRoute` plugin (defined in
 * `mobile/android/.../AudioRoutePlugin.java`). It forces the playback device for
 * WebRTC/stream audio — the OS otherwise routes to the quiet earpiece in
 * `MODE_IN_COMMUNICATION`.
 *
 * In a plain browser (or Electron) these are no-ops — every call is gated on
 * `isCapacitorAndroid()`, so the `@capacitor/core` web-proxy (which throws
 * "not implemented") is never actually invoked.
 */
import { registerPlugin } from '@capacitor/core';
import { isCapacitorAndroid } from './runtime';

export type AudioRoute = 'auto' | 'speaker' | 'earpiece';

interface AudioRoutePlugin {
  setRoute(opts: { route: AudioRoute }): Promise<void>;
  getRoute(): Promise<{ route: AudioRoute }>;
}

const plugin = registerPlugin<AudioRoutePlugin>('AudioRoute');

/** Force the native audio output route. No-op outside the Android wrapper. */
export async function setAudioRoute(route: AudioRoute): Promise<void> {
  if (!isCapacitorAndroid()) return;
  try {
    await plugin.setRoute({ route });
  } catch (e) {
    console.warn('[audioRoute] setRoute failed', e);
  }
}

/** Current native route. Returns `'auto'` outside the Android wrapper. */
export async function getAudioRoute(): Promise<AudioRoute> {
  if (!isCapacitorAndroid()) return 'auto';
  try {
    return (await plugin.getRoute()).route;
  } catch {
    return 'auto';
  }
}
