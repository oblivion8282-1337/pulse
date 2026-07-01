/**
 * Native audio-output routing + audio-diagnostic snapshot (Capacitor Android).
 *
 * The APK loads the web app remotely; Capacitor injects a native bridge so the
 * remote page can call the `AudioRoute` plugin (defined in
 * `mobile/android/.../AudioRoutePlugin.java`). It forces the playback device for
 * WebRTC/stream audio — the OS otherwise routes to the quiet earpiece in
 * `MODE_IN_COMMUNICATION` — and can collect a routing-state snapshot for the
 * "Bluetooth/Car too quiet" diagnosis.
 *
 * In a plain browser (or Electron) these are no-ops — every call is gated on
 * `isCapacitorAndroid()`, so the `@capacitor/core` web proxy (which throws
 * "not implemented") is never actually invoked.
 *
 * Diagnose-Status: die Pipeline steht, hat aber KEINEN Auto-Trigger
 * (``maybeSendAudioDiagnostic`` wird aktuell nirgends gerufen — bewusst
 * „deaktiviert"). Scharfschalten = einen Aufruf an der Stelle der Wahl einbauen.
 */
import { registerPlugin } from '@capacitor/core';
import { request } from '$lib/api/client';
import { isCapacitorAndroid } from './runtime';

export type AudioRoute = 'auto' | 'speaker' | 'earpiece';

/** Native audio-routing snapshot (mirrors AudioRoutePlugin.snapshot). No audio
 *  content — only routing metadata. */
export type AudioDiagnostic = {
  androidSdk: number;
  androidRelease: string;
  mode: string;
  route: string;
  bluetoothScoOn: boolean;
  communicationDevice: { type: string; name: string } | null;
  streams: {
    voiceCall: { volume: number; max: number };
    music: { volume: number; max: number };
  };
  outputDevices: { type: string }[];
};

interface AudioRoutePlugin {
  setRoute(opts: { route: AudioRoute }): Promise<void>;
  getRoute(): Promise<{ route: AudioRoute }>;
  snapshot(): Promise<AudioDiagnostic>;
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

/** Collect the native audio-routing snapshot. No-op outside the Android wrapper. */
export async function getAudioDiagnostic(): Promise<AudioDiagnostic | null> {
  if (!isCapacitorAndroid()) return null;
  try {
    return await plugin.snapshot();
  } catch (e) {
    console.warn('[audioRoute] snapshot failed', e);
    return null;
  }
}

/** Send a diagnostic snapshot to the backend (chat-gateway). Authenticated via
 *  the caller's session; routes to the active server. */
export async function sendAudioDiagnostic(dump: AudioDiagnostic): Promise<void> {
  try {
    await request('/audio-diagnostic', { method: 'POST', body: dump });
  } catch (e) {
    console.warn('[audioRoute] sendAudioDiagnostic failed', e);
  }
}

/** Convenience: snapshot + send. Currently NOT wired anywhere (deaktiviert) —
 *  call this from a chosen trigger point (e.g. voice-join) to activate. */
export async function maybeSendAudioDiagnostic(): Promise<void> {
  const dump = await getAudioDiagnostic();
  if (dump) await sendAudioDiagnostic(dump);
}
