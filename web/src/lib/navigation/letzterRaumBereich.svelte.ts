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
let letzterPfad = $state<string | null>(null);

/** Pfade, die zum Räume-Bereich gehören (gleiche Wurzeln wie tabs.ts). */
export function istRaumBereich(pfad: string): boolean {
  return (
    pfad === '/app/rooms' ||
    pfad.startsWith('/app/rooms/') ||
    pfad.startsWith('/app/guilds/') ||
    pfad === '/app/discover'
  );
}

/** Von app/+layout bei jeder Navigation gerufen, die im Räume-Bereich landet. */
export function merkeRaumPfad(pfad: string): void {
  letzterPfad = pfad;
}

/** Zuletzt angezeigter Räume-Pfad; null = noch keiner (frischer Start). */
export function letzterRaumPfad(): string | null {
  return letzterPfad;
}
