/**
 * Native Brücke in die Mobil-Hüllen: Android zeigt eine
 * Full-Screen-Intent-Notification über dem Sperrbildschirm
 * (`mobile/android …/AnrufPlugin.java`, Anrufe-Epic E), iOS seit dem
 * 2026-10-08 den System-Anrufbildschirm (`mobile/ios …/AnrufPlugin.swift`,
 * Punkt 40) und seit Etappe 4 den ganzen Raum (`nativerAnrufRaum.ts`). Beide
 * Seiten tragen denselben Vertrag: gleicher JS-Name, gleiche Methoden,
 * gleiches `aktion`-Ereignis.
 *
 * Annehmen, Ablehnen und Auflegen kommen als `aktion`-Ereignis zurück
 * (`nativeAktionVerarbeiten`), weil die Signalisierung
 * (anrufAnnehmen/anrufAblehnen) im Klienten lebt. In Browser/Electron No-op.
 *
 * Aus `anruf.svelte.ts` herausgelöst (Grössen-Policy).
 */

import { toast } from 'svelte-sonner';

import { anrufAblehnen, anrufAuflegen } from '$lib/api/anrufe';
import { m } from '$lib/paraglide/messages.js';
import {
  anrufNativ,
  type AnrufAktion,
  type AnrufEndgrund,
  type AnrufRaumZustand
} from '$lib/platform/anrufNativ';
import { nativerAnrufwegDa } from '$lib/platform/anrufNativWeiche';
import { mitFrist, SPRACHE_FRIST_SOFORT_MS } from '$lib/platform/brueckenFrist';
import { isCapacitorAndroid, isCapacitorIOS } from '$lib/platform/runtime';
import type { AnrufStore } from './anruf.svelte';

/** Gibt es hier überhaupt eine native Anrufanzeige? An EINER Stelle, weil
 *  die Antwort drei Riegel in dieser Datei bedient — ein Riegel, der die
 *  neue Hülle vergisst, fällt sonst nur auf dem Gerät auf. */
function nativeHuelle(): boolean {
  return isCapacitorAndroid() || isCapacitorIOS();
}

/** Läuft der Raum eines Anrufs nativ (iOS, Etappe 4)? Die Weiche fragt den
 *  installierten Bau (`anrufNativWeiche.ts`). */
export function nativerAnrufweg(): boolean {
  return isCapacitorIOS() && nativerAnrufwegDa();
}

/** Eingehenden Anruf nativ anzeigen (No-op außerhalb der Mobil-Hüllen).
 *
 *  Auf iOS kann derselbe Anruf ZWEIMAL hier ankommen: einmal über die
 *  WebSocket (dieser Weg) und einmal über den VoIP-Push. Die native Seite
 *  prüft deshalb die Kennung und meldet keinen zweiten Bildschirm für
 *  denselben Anruf. Ein Anruf beginnt immer ohne Kamera — einen
 *  „Videoanruf" als eigene Art gibt es nicht (Bughunt G3). */
export async function nativAnkommen(callId: string, gegenstelle: string): Promise<void> {
  if (!nativeHuelle()) return;
  try {
    await anrufNativ.ankommen({ callId, gegenstelle, video: false });
  } catch (e) {
    console.warn('[anruf] native Klingel-Anzeige fehlgeschlagen', e);
  }
}

/** Native Anzeige entfernen (No-op außerhalb der Mobil-Hüllen). Auf iOS
 *  beendet das den CallKit-Anruf samt nativem Raum — ohne diesen Ruf
 *  klingelte das Telefon weiter, nachdem der Anruf im Web vorbei ist.
 *  `grund` bestimmt, was CallKit in den Anrufverlauf schreibt; ältere
 *  Hüllen und Android übergehen ihn. */
export async function nativBeenden(grund: AnrufEndgrund): Promise<void> {
  if (!nativeHuelle()) return;
  try {
    await anrufNativ.beenden({ grund });
  } catch (e) {
    console.warn('[anruf] native Klingel-Anzeige entfernen fehlgeschlagen', e);
  }
}

/** Ein Gespräch, das die Hülle noch hält (nach einem Reload) — oder `null`. */
export async function nativesGespraech(): Promise<AnrufRaumZustand | null> {
  if (!nativerAnrufweg()) return null;
  const z = await mitFrist(anrufNativ.raumZustand(), SPRACHE_FRIST_SOFORT_MS, 'raumZustand')
    .catch(() => null);
  if (!z || !z.kennung || z.zustand === 'disconnected') return null;
  return z;
}

/**
 * Die native Anzeige an den Anruf-Zustand anbinden (`anruf.svelte.ts`, beim
 * Laden): Annehmen/Ablehnen/Auflegen kommen als `aktion`-Ereignis
 * (`nativeAktionVerarbeiten`), und nach einem Reload übernimmt die Seite ein
 * Gespräch, das die Hülle noch hält (`nativUebernehmen`).
 *
 * **Der Riegel ist PFLICHT:** der Web-Stub von registerPlugin wirft beim
 * addListener ("not implemented on web") und riss sonst das komplette Boot
 * mit — die Login-Seite blieb im Browser weiß (Befund 2026-09-09).
 */
export function nativAnbinden(anrufe: AnrufStore): void {
  if (!nativeHuelle()) return;
  void anrufNativ.addListener('aktion', (daten) => nativeAktionVerarbeiten(anrufe, daten));
  if (nativerAnrufweg()) void anrufe.nativUebernehmen();
}

/**
 * Eine Aktion aus der nativen Anzeige (Android: Notification, iOS: CallKit)
 * am Anruf-Zustand ausführen — `nativAnbinden` hängt das an das
 * `aktion`-Ereignis. Gehört sie nicht zum laufenden Anruf (verspäteter Tap
 * auf eine alte Klingel-Notification), bleibt der Zustand unberührt.
 */
function nativeAktionVerarbeiten(anrufe: AnrufStore, daten: AnrufAktion): void {
  const { aktion, callId } = daten;
  let anruf = anrufe.aktiv;
  // **Der kalt gestartete Anruf ist der Fall, der hier leicht fehlt.** Wird
  // ein Anruf per VoIP-Push auf dem Sperrbildschirm angenommen, hat das Web
  // nie ein `call_klingelt` gesehen: `aktiv` ist leer, und ein blosses
  // „Kennung passt nicht" verwürfe die Annahme. Der Push trägt den Kanal
  // mit, also wird der Zustand hier nachgezogen — erst danach annehmen.
  // `anruf_art` ist `dm`/`gruppe`; bis zum 2026-10-11 stand hier ein
  // Rückfall auf das ungültige `audio` (Bughunt G3).
  if (!anruf && aktion === 'annehmen' && daten.channel_id) {
    anrufe.eingehend(
      {
        call_id: callId,
        art: daten.anruf_art === 'gruppe' ? 'gruppe' : 'dm',
        channel_id: daten.channel_id,
        einleiter_id: daten.einleiter_id ?? ''
      },
      daten.einleiter_name ?? 'Pulse'
    );
    anruf = anrufe.aktiv;
  }
  if (!anruf || anruf.id !== callId) {
    // **Ein Ende, das die Oberfläche nicht kennt** — sie war eingefroren
    // oder neu geladen, während im System-Bildschirm aufgelegt oder
    // abgelehnt wurde oder der native Raum wegbrach. Der Server muss es
    // trotzdem erfahren, sonst sitzt die Gegenseite in einem Anruf mit
    // niemandem. Dafür genügt die Kennung; der Kontext (`channel_id`, …)
    // zählt nur für eine Annahme (oben) und fehlt bei einem Anruf, den die
    // Hülle ohne CallKit führte (`vonDerHuelleBeendet`, Anrufverwaltung).
    // `getrennt` fiel hier bis zum 2026-10-11 still durch — ein bekannter
    // Anruf legt dafür auf (`auflegen('fehler')` unten), ein unbekannter tat
    // nichts.
    if (aktion === 'auflegen' || aktion === 'getrennt') void anrufAuflegen(callId).catch(() => {});
    else if (aktion === 'ablehnen') void anrufAblehnen(callId).catch(() => {});
    return;
  }
  switch (aktion) {
    case 'annehmen':
      void anrufe.annehmen(anruf.gegenstelle);
      break;
    case 'auflegen':
      void anrufe.auflegen();
      break;
    case 'getrennt':
      // Der native Raum ist weg — wie ein Abbruch im Web-Weg. Der Server
      // bekommt das Auflegen mit, damit die Gegenseite nicht wartet.
      toast.error(m.anruf_verbindung_verloren());
      void anrufe.auflegen('fehler');
      break;
    default:
      // **`ablehnen` aus CallKit gilt nur für einen KLINGELNDEN Anruf** (M5):
      // ein laufender wird über `auflegen` beendet. Eine ältere Hülle schickt
      // für beides `ablehnen` — dann entscheidet hier der eigene Zustand.
      if (anruf.zustand === 'klingelt') void anrufe.ablehnen();
      else void anrufe.auflegen();
  }
}
