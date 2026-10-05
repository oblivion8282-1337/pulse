import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { isCapacitorAndroid } from './runtime';

/**
 * Bridge zum nativen Voice-Motor der APK (docs/UEBERGABE-MOBILE-VOICE-NATIV.md).
 * Der native Join trägt den Ton im Anrufkanal (USAGE_VOICE_COMMUNICATION) — am
 * eingebauten Lautsprecher folgt er damit dem Anruf-Regler statt dem
 * Medien-Regler — und nimmt das Mikrofon über das SDK auf.
 *
 * Version-Skew (Übergabe §5.3): die WebView lädt das Web remote, die APK rollt
 * langsamer. Deshalb doppelt abgesichert — das Opt-in-Flag `pulse.nativeVoice`
 * muss gesetzt sein UND jeder Bridge-Call steckt im try/catch; ein fehlendes
 * oder zu altes Plugin wirft, und der Web-Pfad läuft unverändert weiter.
 *
 * Snapshot-Contract (JSON-String vom nativen 'voice'-Event):
 *   { participants?: [{ identity, name, isLocal, isSpeaking, audioLevel,
 *                       micMuted, cameraOn, connectionQuality }],
 *     state?: 'connected' | 'reconnecting' | 'disconnected' }
 */

/** Teilnehmer-Zeile aus dem nativen Snapshot (roh — Aufbereitung macht die Fassade). */
export type NativeParticipantSnapshot = {
  identity: string;
  name: string;
  isLocal: boolean;
  isSpeaking: boolean;
  audioLevel: number;
  micMuted: boolean;
  cameraOn: boolean;
  connectionQuality: string;
};

export type NativeVoiceSnapshot = {
  /** Raum-Etikett ('voice' | 'anruf:<id>') — Demux für die zwei Konsumenten. */
  tag?: string;
  participants?: NativeParticipantSnapshot[];
  state?: 'connected' | 'reconnecting' | 'disconnected';
};

interface NativeVoicePlugin {
  join(opts: {
    ws_url: string;
    token: string;
    echoCancellation: boolean;
    noiseSuppression: boolean;
    tag: string;
  }): Promise<void>;
  leave(): Promise<void>;
  setMicEnabled(opts: { on: boolean }): Promise<void>;
  setDeafened(opts: { on: boolean }): Promise<void>;
  state(): Promise<{ connected: boolean }>;
  snapshot(): Promise<void>;
  playSound(opts: { id: string }): Promise<void>;
  addListener(
    eventName: 'voice',
    cb: (data: { snapshot: string }) => void
  ): Promise<PluginListenerHandle>;
}

const plugin = registerPlugin<NativeVoicePlugin>('Voice');

const FLAG = 'pulse.nativeVoice';

/** Opt-in-Schalter für die Kernprobe — bewusst ein localStorage-Flag, kein
 *  Dauerzustand: der native Pfad ersetzt die Web-Engine komplett. */
export function nativeVoiceFlagged(): boolean {
  if (!isCapacitorAndroid()) return false;
  try {
    return localStorage.getItem(FLAG) === '1';
  } catch {
    return false;
  }
}

/** true, solange DIESE Web-Session den Ton nativ trägt (nach Reload vergessen
 *  — dafür gibt es den state()-Abgleich in nativeVoiceLeave). */
let nativeActive = false;

/** Nativen Join versuchen. `tag` trennt die Konsumenten ('voice' |
 *  'anruf:<id>'). `true` = die Engine trägt Ton/Mic jetzt, der Web-Pfad darf
 *  übersprungen werden; `false` = normal weiter. */
export async function nativeVoiceJoin(
  resp: { ws_url: string; token: string },
  echoCancellation: boolean,
  noiseSuppression: boolean,
  tag = 'voice'
): Promise<boolean> {
  if (!nativeVoiceFlagged()) return false;
  try {
    await plugin.join({ ws_url: resp.ws_url, token: resp.token, echoCancellation, noiseSuppression, tag });
    nativeActive = true;
    return true;
  } catch (e) {
    console.warn('[nativeVoice] join fehlgeschlagen — Fallback auf Web-Engine', e);
    return false;
  }
}

/** Native Engine abmelden. `true` = sie trug den Ton (oder hält eine Waise aus
 *  einem WebView-Reload — die Engine lebt im APK-Prozess weiter) und räumt
 *  jetzt ab; `false` = nichts zu tun, der Web-Pfad darf normal weiterlaufen. */
export async function nativeVoiceLeave(): Promise<boolean> {
  if (!nativeVoiceFlagged()) return false;
  try {
    if (!nativeActive) {
      const s = await plugin.state();
      if (!s.connected) return false;
    }
    nativeActive = false;
    await plugin.leave();
    return true;
  } catch (e) {
    nativeActive = false;
    console.warn('[nativeVoice] leave fehlgeschlagen', e);
    return false;
  }
}

/** Merker zurücksetzen, wenn die ENGINE sich selbst getrennt hat (Snapshot
 *  state=disconnected) — sonst bliebe die Fassade im native-Modus hängen. */
export function nativeVoiceReset(): void {
  nativeActive = false;
}

/** Trägt die native Engine gerade Ton/Mic dieser Session? */
export function nativeVoiceEngaged(): boolean {
  return nativeActive;
}

/** Snapshot-Listener anhängen (einmal pro Join). */
export async function nativeVoiceListen(
  cb: (snapshot: NativeVoiceSnapshot) => void
): Promise<PluginListenerHandle | null> {
  if (!nativeVoiceFlagged()) return null;
  try {
    return await plugin.addListener('voice', (data) => {
      try {
        cb(JSON.parse(data.snapshot) as NativeVoiceSnapshot);
      } catch (e) {
        console.warn('[nativeVoice] Snapshot unparsebar', e);
      }
    });
  } catch (e) {
    console.warn('[nativeVoice] addListener fehlgeschlagen', e);
    return null;
  }
}

/** Mikrofon nativ publishen/zurückziehen (Permission fragt das Plugin ab). */
export async function nativeSetMicEnabled(on: boolean): Promise<void> {
  await plugin.setMicEnabled({ on });
}

/** Taub-Schaltung nativ (nur Wiedergabe — Mic-Kopplung macht die Fassade). */
export async function nativeSetDeafened(on: boolean): Promise<void> {
  await plugin.setDeafened({ on });
}

/** voice.*-Klang nativ im Anrufkanal abspielen (SoundPool, siehe P5). */
export async function nativePlaySound(id: string): Promise<void> {
  try {
    await plugin.playSound({ id });
  } catch (e) {
    console.warn('[nativeVoice] playSound fehlgeschlagen', e);
  }
}

/** Aktuellen Teilnehmer-Stand ziehen — direkt nach dem Anhängen des
 *  Listeners, sonst ginge der beim Connect gefeuerte erste Snapshot verloren. */
export async function nativeVoiceSnapshot(): Promise<void> {
  try {
    await plugin.snapshot();
  } catch (e) {
    console.warn('[nativeVoice] snapshot fehlgeschlagen', e);
  }
}
