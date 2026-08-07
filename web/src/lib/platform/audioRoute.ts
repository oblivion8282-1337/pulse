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
 * Diagnose-Status: ``maybeSendAudioDiagnostic`` wird beim Voice-Join gefeuert
 * (in ``livekit.svelte.ts``), nachdem das Routing gesetzt ist — es verifiziert
 * das Ergebnis (Mode, Communication-Device, SCO-Status) für die „im Auto zu
 * leise"-Diagnose. Nur unter Capacitor-Android aktiv, sonst No-op.
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
  /** Web-seitiger Fehler beim letzten setVoiceActive (z.B. Plugin nicht geladen).
   *  Nur belegt, wenn der Aufruf scheiterte — wird vom Web in den Dump gesetzt. */
  setVoiceActiveError?: string | null;
};

interface AudioRoutePlugin {
  setRoute(opts: { route: AudioRoute }): Promise<void>;
  getRoute(): Promise<{ route: AudioRoute }>;
  setVoiceActive(opts: { active: boolean }): Promise<void>;
  snapshot(): Promise<AudioDiagnostic>;
}

const plugin = registerPlugin<AudioRoutePlugin>('AudioRoute');

/** Letzter Fehler aus setVoiceActive (null = erfolgreich). Landet im Diagnose-
 *  Snapshot, damit ein stiller Routing-Fehlschlag im Feld sichtbar wird. */
let lastSetVoiceActiveError: string | null = null;

/** Force the native audio output route. No-op outside the Android wrapper. */
export async function setAudioRoute(route: AudioRoute): Promise<void> {
  if (!isCapacitorAndroid()) return;
  try {
    await plugin.setRoute({ route });
  } catch (e) {
    console.warn('[audioRoute] setRoute failed', e);
  }
}

/**
 * Signal a voice-channel join (`true`) or leave (`false`) to the native router.
 * On join it forces `MODE_IN_COMMUNICATION` so voice routes to the phone-call
 * channel (Bluetooth SCO) instead of the media channel (A2DP); on leave it
 * releases the mode. No-op outside the Android wrapper.
 */
export async function setVoiceActive(active: boolean): Promise<void> {
  if (!isCapacitorAndroid()) return;
  try {
    await plugin.setVoiceActive({ active });
    lastSetVoiceActiveError = null;
  } catch (e) {
    lastSetVoiceActiveError = e instanceof Error ? e.message : String(e);
    console.warn('[audioRoute] setVoiceActive failed', e);
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

/** Convenience: snapshot + send, but only when a Bluetooth output is present —
 *  that is the "too quiet in the car" scenario we diagnose. Skipping the
 *  non-BT case keeps the backend log focused instead of one entry per join.
 *  Wired from the voice-join path in `livekit.svelte.ts` (fired once, after
 *  routing settles). */
export async function maybeSendAudioDiagnostic(): Promise<void> {
  const dump = await getAudioDiagnostic();
  if (!dump) return;
  const hasBluetooth = dump.outputDevices.some((d) => d.type.startsWith('BLUETOOTH'));
  if (!hasBluetooth) return;
  // Web-seitigen Routing-Fehler in den Dump schreiben (Plugin nicht geladen etc.),
  // damit er im Feld-Snapshot auftaucht statt nur in der Browser-Konsole.
  dump.setVoiceActiveError = lastSetVoiceActiveError;
  await sendAudioDiagnostic(dump);
}
