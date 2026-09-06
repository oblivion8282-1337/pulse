/**
 * Reine Entscheidung: gehoert ein Satz zum angemeldeten Konto? — importfrei,
 * damit Nodes Testlaeufer sie direkt prueft (kein erweiterungsloser
 * Laufzeit-Import, kein `$state()` auf Modulebene, s. CLAUDE.md „Die Falle").
 *
 * Bughunt 2026-08-29 (Befund 1): der lokale Verlauf (`verlauf/db.ts`) lag
 * bisher unter EINER Datenbank pro Browserprofil, ohne Bezug zum angemeldeten
 * Konto. Meldet sich auf demselben Geraet ein zweites Konto an, sah dessen
 * Suche (und jeder andere Lesepfad) den kompletten Bestand des ersten Kontos
 * — Gespraechspartner und Zeitpunkte eingeschlossen. `kontoId` traegt seither
 * jeder Satz (`schema.ts`, gesetzt beim Schreiben aus dem GERADE angemeldeten
 * Konto, `verlauf/konto.ts::aktuellesKonto`); diese Funktion ist die EINZIGE
 * Stelle, die beim Lesen entscheidet, ob ein Satz gezeigt werden darf —
 * `verlauf/db.ts` ruft sie in jedem Lesepfad (Suche, Nachladen, Vorschau,
 * Umzug).
 *
 * Ein Satz OHNE `kontoId` (Bestand von vor diesem Fix, oder eine kaputte
 * Zeile) gehoert bewusst zu KEINEM Konto — fail-closed statt einer Ratenwette
 * auf den aktuellen Nutzer.
 */
export type SatzMitKonto = { kontoId: string | null | undefined };

export function gehoertZuKonto(satz: SatzMitKonto, kontoId: string): boolean {
  // Leere Vergleichs-ID ist kein Konto (`konto.ts::aktuellesKonto` liefert
  // dafuer `null`, nie ''), auch wenn eine kaputte Zeile zufaellig '' traegt.
  if (kontoId === '') return false;
  return typeof satz.kontoId === 'string' && satz.kontoId === kontoId;
}
