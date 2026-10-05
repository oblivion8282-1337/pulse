import { registerPlugin } from '@capacitor/core';
import { isCapacitorAndroid } from './runtime';

/**
 * Bridge zum nativen Voice-Motor der APK (P1-Kernprobe,
 * docs/UEBERGABE-MOBILE-VOICE-NATIV.md). Der native Join trägt den Ton im
 * Anrufkanal (USAGE_VOICE_COMMUNICATION) — am eingebauten Lautsprecher folgt
 * er damit dem Anruf-Regler statt dem Medien-Regler.
 *
 * Version-Skew (Übergabe §5.3): die WebView lädt das Web remote, die APK rollt
 * langsamer. Deshalb doppelt abgesichert — das Opt-in-Flag `pulse.nativeVoice`
 * muss gesetzt sein UND jeder Bridge-Call steckt im try/catch; ein fehlendes
 * oder zu altes Plugin wirft, und der Web-Pfad läuft unverändert weiter.
 */

interface NativeVoicePlugin {
  join(opts: { ws_url: string; token: string }): Promise<void>;
  leave(): Promise<void>;
  state(): Promise<{ connected: boolean }>;
}

const plugin = registerPlugin<NativeVoicePlugin>('Voice');

const FLAG = 'pulse.nativeVoice';

/** Opt-in-Schalter für die Kernprobe — bewusst ein localStorage-Flag, kein
 *  Dauerzustand: der native Pfad ersetzt in P1 die Web-Engine komplett. */
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

/** Nativen Join versuchen (nur Zuhören). `true` = die Engine trägt den Ton
 *  jetzt, der Web-Pfad darf übersprungen werden; `false` = normal weiter. */
export async function nativeVoiceJoin(resp: {
  ws_url: string;
  token: string;
}): Promise<boolean> {
  if (!nativeVoiceFlagged()) return false;
  try {
    await plugin.join({ ws_url: resp.ws_url, token: resp.token });
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
