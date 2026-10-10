import { errText } from '$lib/utils/errText';
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
import { isCapacitorAndroid, isCapacitorIOS } from './runtime';
import { iosAirplayWaehler, iosTonWege, iosTonWegSetzen } from './iosAudioSession';

export type AudioRoute = 'auto' | 'speaker' | 'earpiece';

/** Ein umschaltbares Ausgabegerät aus dem Route-Popup (Hörmuschel,
 *  Lautsprecher oder verbundenes Bluetooth). */
type AudioRouteDevice = {
  /** Native Geräte-Id — an setAudioRouteDevice zurückgeben zum Umschalten. */
  id: number;
  /** BUILTIN_SPEAKER | BUILTIN_EARPIECE | BLUETOOTH_SCO | BLE_HEADSET */
  type: string;
  name: string;
};

export type AudioRouteList = {
  current: AudioRoute | 'device';
  /** Bei current === 'device': die gepinnte Geräte-Id, sonst 0. */
  currentDeviceId: number;
  devices: AudioRouteDevice[];
};

/** Native audio-routing snapshot (mirrors AudioRoutePlugin.snapshot). No audio
 *  content — only routing metadata. */
type AudioDiagnostic = {
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
  setRoute(opts: { route?: AudioRoute; deviceId?: number }): Promise<void>;
  getRoute(): Promise<{ route: AudioRoute }>;
  listRoutes(): Promise<AudioRouteList>;
  setVoiceActive(opts: { active: boolean }): Promise<void>;
  snapshot(): Promise<AudioDiagnostic>;
}

const plugin = registerPlugin<AudioRoutePlugin>('AudioRoute');

/** Letzter Fehler aus setVoiceActive (null = erfolgreich). Landet im Diagnose-
 *  Snapshot, damit ein stiller Routing-Fehlschlag im Feld sichtbar wird. */
let lastSetVoiceActiveError: string | null = null;

/**
 * iOS-Porttyp → die Wahl, die die Oberfläche kennt.
 *
 * Alles, was weder eingebauter Lautsprecher noch Hörmuschel ist (AirPods,
 * Autoradio, Kabel-Headset), meldet `device` — dann zeigt die Leiste das
 * Bluetooth-Zeichen und markiert keinen der beiden festen Wege. Dass dort
 * KEIN Gerätename steht, ist Absicht: auf iOS wählt man das Gerät im System
 * (Kontrollzentrum bzw. AirPlay-Knopf, Roadmap-Punkt 30), nicht in der App —
 * eine eigene Liste wäre eine zweite, schlechtere Bedienung derselben Sache.
 */
function iosWegZuWahl(porttyp: string): AudioRoute | 'device' {
  if (porttyp === 'Speaker') return 'speaker';
  if (porttyp === 'Receiver') return 'earpiece';
  return 'device';
}

/** Force the native audio output route. No-op outside the mobile wrappers
 *  (Android and iOS). Either a fixed way (`route`) or one concrete device from
 *  {@link listAudioRoutes} (`deviceId` — z. B. ein bestimmtes BT-Headset); the
 *  `deviceId` form is Android-only, see the iOS branch below. */
export async function setAudioRoute(
  route?: AudioRoute,
  deviceId?: number
): Promise<void> {
  if (isCapacitorIOS()) {
    // Auf iOS gibt es nur die beiden Übersteuerungen; `auto` heisst dort
    // „nicht übersteuern", und das ist die Hörmuschel-Seite.
    if (route) {
      const ok = await iosTonWegSetzen(route === 'earpiece' ? 'earpiece' : 'speaker');
      // Ergebnis NICHT wegwerfen — der Android-Zweig unten meldet seit jeher,
      // der iOS-Zweig war der einzige voellig stumme.
      if (!ok) console.warn('[audioRoute] iOS-Ausgabewahl ohne Wirkung:', route);
    }
    return;
  }
  if (!isCapacitorAndroid()) return;
  try {
    await plugin.setRoute({ route, deviceId });
  } catch (e) {
    console.warn('[audioRoute] setRoute failed', e);
  }
}

/** `true`, wenn diese Hülle die AirPlay-Auswahl des Systems öffnen kann.
 *
 *  Nur iOS. Android hat kein AirPlay, und im Browser gibt es keinen Weg zu
 *  einem System-Dialog — dort bleibt der Eintrag deshalb aus, statt zu
 *  erscheinen und nichts zu tun. */
export function airplayMoeglich(): boolean {
  return isCapacitorIOS();
}

/** Öffnet die AirPlay-Auswahl. `false` = ging nicht, dann hilft nur das
 *  Kontrollzentrum (s. `iosAirplayWaehler`). */
export async function airplayOeffnen(): Promise<boolean> {
  return iosAirplayWaehler();
}

/** Auswahl-Liste für das Route-Popup (Geräte + aktuelle Wahl). Liefert eine
 *  leere Liste außerhalb des Android-Wrappers. */
export async function listAudioRoutes(): Promise<AudioRouteList> {
  if (isCapacitorIOS()) {
    const wege = await iosTonWege();
    return {
      current: wege ? iosWegZuWahl(wege.aktuell) : 'auto',
      currentDeviceId: 0,
      // Bewusst leer, s. `iosWegZuWahl`. Das Menü rendert die beiden festen
      // Wege ohnehin und die Geräteliste nur, wenn welche da sind.
      devices: []
    };
  }
  if (!isCapacitorAndroid()) return { current: 'auto', currentDeviceId: 0, devices: [] };
  try {
    return await plugin.listRoutes();
  } catch (e) {
    console.warn('[audioRoute] listRoutes failed', e);
    return { current: 'auto', currentDeviceId: 0, devices: [] };
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
    lastSetVoiceActiveError = errText(e);
    console.warn('[audioRoute] setVoiceActive failed', e);
  }
}

/** Collect the native audio-routing snapshot. No-op outside the Android wrapper. */
async function getAudioDiagnostic(): Promise<AudioDiagnostic | null> {
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
async function sendAudioDiagnostic(dump: AudioDiagnostic): Promise<void> {
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
