/**
 * Die Ergebnis-Spalte in Worten — und in ihrer Farbe.
 *
 * Getrennt von `herkunft.ts`, damit die Rechnung ohne Sprache auskommt: dort
 * steht, WAS entschieden hat, hier, wie man es sagt. „ja · aus Moderation" ist
 * die Antwort, die jemand sucht — nicht „ja".
 *
 * Die Farbe steht daneben, weil sie dieselbe Entscheidung trifft wie der Text
 * und an zwei Stellen gebraucht wird (Rechte-Zeile und Prüfen-Liste); zweimal
 * ausgeschrieben wichen die beiden Ansichten irgendwann voneinander ab.
 */

import { m } from '$lib/paraglide/messages.js';
import type { Herkunft, Rechtsstand } from './herkunft';

export function herkunftText(h: Herkunft): string {
  switch (h.art) {
    case 'besitzer':
      return m.kanalrechte_woher_besitzer();
    case 'administrator':
      return m.kanalrechte_woher_administrator({ rolle: h.rolle });
    case 'rolle':
      return m.kanalrechte_woher_rolle({ rolle: h.rolle });
    case 'keine_rolle':
      return m.kanalrechte_woher_keine_rolle();
    case 'hier_erlaubt':
      return h.ueber
        ? m.kanalrechte_woher_hier_erlaubt_ueber({ ziel: h.ueber })
        : m.kanalrechte_woher_hier_erlaubt();
    case 'hier_verboten':
      return h.ueber
        ? m.kanalrechte_woher_hier_verboten_ueber({ ziel: h.ueber })
        : m.kanalrechte_woher_hier_verboten();
    case 'sichtsperre':
      return m.kanalrechte_woher_sichtsperre();
    case 'kein_mitglied':
      return m.kanalrechte_woher_kein_mitglied();
  }
}

/** „ja · aus Moderation" · „nein · hier verboten" · „fällt weg". */
export function ergebnisText(stand: Rechtsstand): string {
  if (stand.herkunft.art === 'sichtsperre') return m.kanalrechte_faellt_weg();
  const ja = stand.gilt ? m.kanalrechte_ja() : m.kanalrechte_nein();
  return `${ja} · ${herkunftText(stand.herkunft)}`;
}

/** Tailwind-Klasse zum Ergebnis: gedämpft, wenn es an der Sichtsperre wegfällt. */
export function ergebnisFarbe(stand: Rechtsstand): string {
  if (stand.herkunft.art === 'sichtsperre') return 'text-text-muted';
  return stand.gilt ? 'text-green-400' : 'text-red-400';
}
