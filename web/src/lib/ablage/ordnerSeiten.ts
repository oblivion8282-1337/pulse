/**
 * Die Seiten-Rechnung des Kanal-Ordners — was als Cursor an die naechste
 * Anfrage geht und wann das Blaettern zu Ende ist.
 *
 * **Der Cursor ist die NUTZLAST-ID, nicht der Dateiname.** Der Server
 * (`routes/ablage_kanal_ordner.py::_cursor_id`) liest `nach` als Zahl und
 * antwortet seit dem 2026-09-03 mit 422, wenn es keine ist. Vorher blendete
 * ein unlesbarer Cursor schlicht nichts aus — der Klient reichte den letzten
 * NAMEN (`17.puls`) weiter, bekam jede Seite unveraendert zurueck und legte
 * damit entweder endlos oder doppelt ab, ohne dass irgendwo ein Fehler
 * erschien. Genau diese Naht steht deshalb hier als eigene, pruefbare
 * Rechnung statt inmitten des Netzweges.
 *
 * Importfrei bis auf `./ordnerDateien.ts` (mit Endung, sonst findet Nodes
 * eingebauter Testlaeufer die Datei nicht — s. CLAUDE.md „Die Falle").
 */

import { nutzlastIdAusName } from './ordnerDateien.ts';

/**
 * Der Cursor fuer die naechste Seite: die Nutzlast-ID des letzten Namens
 * dieser Seite. `null`, wenn die Seite keinen einzigen brauchbaren Namen
 * traegt — dann gibt es keinen Punkt, hinter dem weitergelesen werden
 * koennte, und der Aufrufer MUSS abbrechen statt mit dem alten Cursor
 * weiterzumachen (das waere die Endlosschleife).
 *
 * Gesucht wird von hinten: der Server sortiert numerisch aufsteigend, der
 * letzte Name traegt also die hoechste ID. Ein Fremdname am Ende (den der
 * Server eigentlich herausfiltert) laesst die Rechnung nicht kippen, sondern
 * nur einen Schritt zurueckgehen.
 */
export function naechsterCursor(namen: readonly string[]): string | null {
  for (let i = namen.length - 1; i >= 0; i--) {
    const id = nutzlastIdAusName(namen[i]);
    if (id !== null) return id;
  }
  return null;
}

/**
 * Ob diese Seite die letzte war. Eine nicht volle Seite kann keine weitere
 * hinter sich haben — der Server schneidet erst bei `seitengroesse` ab.
 */
export function fertig(namen: readonly string[], seitengroesse: number): boolean {
  return namen.length < seitengroesse;
}
