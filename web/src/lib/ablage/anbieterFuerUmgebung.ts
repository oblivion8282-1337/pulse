/**
 * Reine Rechnung fuer Plan-Aufgabe 4 (`docs/superpowers/plans/2026-08-31-
 * ablage-e3-persoenliches-archiv.md`): welche Anbieter zeigt der
 * Verbinden-Dialog in dieser Umgebung?
 *
 * | Umgebung        | Ordner waehlbar | Cloud waehlbar |
 * |-----------------|------------------|----------------|
 * | Desktop-App     | ja               | ja             |
 * | Chrome/Edge     | ja               | ja             |
 * | Firefox/Safari  | nein             | ja             |
 *
 * Der wichtigste Satz der Etappe: in Firefox/Safari wird NICHTS
 * abgeschaltet, es faellt nur `sync_ordner` aus der Auswahl — eine
 * Cloud-Verbindung bleibt in jeder Umgebung waehlbar. Die Ordner-Auswahl
 * scheitert sonst erst beim Klick (`syncOrdner.ts::wähleOrdner` gibt dann
 * `null` zurueck); besser, sie taucht dort gar nicht erst auf.
 *
 * Importfrei — `syncOrdner.ts::syncOrdnerMoeglich()` prueft `window`
 * selbst; hier steht nur, was mit dem Ergebnis passiert.
 */

import type { AnbieterEintrag } from './anbieter.ts';

export function anbieterFuerUmgebung(
	angebotene: readonly AnbieterEintrag[],
	ordnerMoeglich: boolean
): AnbieterEintrag[] {
	return angebotene.filter((a) => a.art !== 'sync_ordner' || ordnerMoeglich);
}
