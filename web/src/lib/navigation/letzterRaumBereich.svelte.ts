/**
 * Der zuletzt angezeigte Bildschirm im Räume-Bereich.
 *
 * Der Räume-Tab der Navigationsleiste kehrt genau dorthin zurück — egal
 * welche Ebene: Sprachkanal, Text-Chat, Raum-Ansicht (Kanalliste) oder die
 * Übersicht. Gemerkt wird bei JEDER Navigation innerhalb des Bereichs
 * (`/app/rooms…`, `/app/guilds…`, Entdecken), also auch beim bewussten
 * Zurücknavigieren: Wer zur Übersicht zurückgeht, hat die Übersicht als
 * letzten Stand — der Tab wirft ihn nicht mehr in den Kanal zurück.
 *
 * Modul-Zustand (kein Persistenz): nach App-Neustart ist nichts gemerkt,
 * der Räume-Tab startet auf der Übersicht.
 */
import { aktiverBereich } from './tabs';

let letzterPfad = $state<string | null>(null);

/**
 * Pfade, die zum Räume-Bereich gehören.
 *
 * **Fragt `tabs.ts`, statt die Wurzeln erneut aufzuzählen.** Eine eigene Liste
 * stand hier und wich in einer Kleinigkeit ab: sie verglich mit blossem
 * `startsWith`, ohne die Segmentgrenze, die `aktiverBereich` mitbringt — eine
 * künftige Route `/app/roomsomething` zählte damit für die eine Kopie zu den
 * Räumen und für die andere nicht. `tabs.ts` ist ausdrücklich die einzige
 * Stelle, die „welcher Bereich" entscheidet; hier wird sie nur gefragt.
 */
export function istRaumBereich(pfad: string): boolean {
  return aktiverBereich(pfad) === 'rooms';
}

/** Von app/+layout bei jeder Navigation gerufen, die im Räume-Bereich landet. */
export function merkeRaumPfad(pfad: string): void {
  letzterPfad = pfad;
}

/** Zuletzt angezeigter Räume-Pfad; null = noch keiner (frischer Start). */
export function letzterRaumPfad(): string | null {
  return letzterPfad;
}
