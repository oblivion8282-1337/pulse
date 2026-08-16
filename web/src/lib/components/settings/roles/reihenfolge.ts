/**
 * Umsortieren der Rangleiter — welche Zeilen gehen wirklich an den Server.
 *
 * Das ist der heikelste Teil der Rollenverwaltung, deshalb steht er als
 * reine Funktion hier statt in der Komponente.
 *
 * Es gehen NUR die tatsaechlich bewegten Rollen mit: der Server
 * (`roles.py::update_role_positions`) lehnt jeden Eintrag ab, dessen alte
 * ODER neue Position auf oder ueber der Hoechstposition des Bearbeiters
 * liegt — und dessen eigene hoechste Rolle steckte in der frueheren
 * Nutzlast (ganze Liste durchnummeriert) immer mit drin, was jeden
 * Pfeilklick fuer alle ausser Besitzer/Instanz-Admin auf 403 warf.
 *
 * Bewegt ist der zusammenhaengende Bereich zwischen erster und letzter
 * Abweichung zur alten Reihenfolge; darin werden die BEREITS VORHANDENEN
 * Positionswerte durchgereicht statt neu vergeben, damit die Menge der
 * Positionen unveraendert bleibt (keine neuen Gleichstaende, nichts
 * rutscht ueber die Decke des Bearbeiters).
 */

import type { Role } from '$lib/api/roles';

export type Umsortierung =
  /** Nichts bewegt — gar nicht erst senden. */
  | { art: 'unveraendert' }
  /**
   * Entartet: alle Positionen im bewegten Bereich sind gleich (der Server
   * erlaubt Gleichstand). Ohne verschiedene Werte laesst sich die neue
   * Reihenfolge nicht ausdruecken — melden statt still nichts tun.
   */
  | { art: 'nicht_darstellbar' }
  | { art: 'senden'; eintraege: { id: string; position: number }[] };

export function bewegterAusschnitt(vorher: Role[], nachher: Role[]): Umsortierung {
  let lo = 0;
  while (lo < vorher.length && vorher[lo].id === nachher[lo].id) lo++;
  let hi = vorher.length - 1;
  while (hi > lo && vorher[hi].id === nachher[hi].id) hi--;
  if (lo >= hi) return { art: 'unveraendert' };

  const eintraege: { id: string; position: number }[] = [];
  for (let i = lo; i <= hi; i++) {
    const position = vorher[i].position;
    if (nachher[i].position !== position) {
      eintraege.push({ id: nachher[i].id, position });
    }
  }
  if (eintraege.length === 0) return { art: 'nicht_darstellbar' };
  return { art: 'senden', eintraege };
}

/** Eine Rolle um einen Platz verschieben. Gibt die neue Liste zurueck,
 * oder `null`, wenn der Zug aus der Liste hinausfuehrte. */
export function verschoben(liste: Role[], index: number, richtung: -1 | 1): Role[] | null {
  const ziel = index + richtung;
  if (index < 0 || ziel < 0 || ziel >= liste.length) return null;
  const neu = [...liste];
  [neu[index], neu[ziel]] = [neu[ziel], neu[index]];
  return neu;
}

/** Eine Rolle an die Stelle einer anderen ziehen (Einfuegen VOR dem Ziel). */
export function gezogen(liste: Role[], vonIndex: number, nachIndex: number): Role[] | null {
  if (vonIndex < 0 || nachIndex < 0 || vonIndex >= liste.length || nachIndex >= liste.length) {
    return null;
  }
  const neu = [...liste];
  const [bewegt] = neu.splice(vonIndex, 1);
  neu.splice(nachIndex, 0, bewegt);
  return neu;
}
