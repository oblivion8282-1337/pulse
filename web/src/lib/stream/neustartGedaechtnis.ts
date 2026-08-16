/**
 * Was ein laufender Stream für seinen eigenen Neustart wissen muss.
 *
 * Der Sidecar beendet einen Stream kontrolliert, wenn die Aufnahmequelle ihre
 * Auflösung ändert; `autoRestart.ts` setzt ihn dann neu auf. Dafür braucht der
 * Neustart Angaben, die im Zustand des Streams nirgends stehen — den Kanal und,
 * seit den Standplatz-Geräten, ob dieser Strom überhaupt einem Menschen am
 * Rechner gehört oder einem ferngeweckten Gerät.
 *
 * **Warum eine eigene Datei und nicht einfach in `autoRestart.ts`:** dort lagen
 * diese Angaben ursprünglich, und der Neustart hat den ganzen Startvorgang
 * daneben nachgebaut. Damit `autoRestart.ts` stattdessen den gemeinsamen Weg
 * (`starten.ts`) rufen kann, ohne dass sich die beiden Dateien gegenseitig
 * importieren, wohnt das Gedächtnis dazwischen.
 *
 * **Warum der Standplatz-Satz mitgemerkt wird** (Befund 2026-08-16): ohne ihn
 * baute der Neustart die Argumente aus den Einstellungen des BESITZERS — ein
 * geweckter Rechner wechselte nach einer Auflösungsänderung still Codec,
 * Sendeweg und Aufnahmequelle, und zwar auf die Werte dessen, der gerade nicht
 * davorsitzt. Eine stille Umgehung des Profils, ausgelöst von aussen.
 */

import type { AudioMode, OverrideSet } from './settingsCatalog';

/** Der Standplatz-Satz, wie ihn `streamStarten` und `buildStartArgs` erwarten. */
export interface StandplatzStart {
  quelle: string;
  uebersteuerung: OverrideSet;
  ton: AudioMode;
}

export interface Neustartbar {
  channelId: string;
  /** Fehlt bei einem Strom, den ein Mensch am Rechner gestartet hat. */
  standplatz?: StandplatzStart;
}

const gemerkt: Record<number, Neustartbar> = {};

/** Vom gemeinsamen Startweg nach erfolgreichem `gsr.start` gerufen. */
export function startMerken(slot: number, eintrag: Neustartbar): void {
  gemerkt[slot] = eintrag;
}

/** Nichts gemerkt heisst: kein Auto-Neustart. */
export function gemerkterStart(slot: number): Neustartbar | undefined {
  return gemerkt[slot];
}
