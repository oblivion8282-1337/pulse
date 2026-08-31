/**
 * Was hereinkommt, bevor es ein Ziel gibt.
 *
 * **Der Befund aus Plan 1b-1:** ein `neu` der Gegenseite, das eintrifft, bevor
 * der eigene Player ein Fenster hat (Steuernder) oder bevor ein Träger feststeht
 * (Host), war unwiederbringlich verloren. Es ging an Sitzung 0, die es nicht
 * gibt, und wurde still verworfen; eine Auffrischung ließ sich nicht erbitten,
 * weil `neu_bitte` **lokal** ist — es bittet die eigene Plattform, nicht die
 * fremde. Die Gegenseite kündigt aber nur an, wenn sich dort etwas ändert.
 * Ergebnis: die Zwischenablage blieb für den Rest der Sitzung in einer
 * Richtung tot, ohne Log und ohne sichtbare Ursache.
 *
 * In 1b-1 war das folgenlos, weil die Host-Seite fehlte. Mit ihr ist es der
 * Normalfall: die Fernsteuerungs-Sitzung beginnt, **bevor** der Steuernde sein
 * Player-Fenster hat, und der Host kündigt seinen ersten Stand an, sobald er
 * wach ist.
 *
 * **Die Lösung ist Zurückhalten, nicht Nachfragen.** Nachfragen hieße einen
 * fünften Rahmen auf der Leitung (der Entwurf nennt genau vier), und die
 * Gegenseite müsste ihn verstehen — auch die ältere. Zurückhalten kostet
 * nichts und wirkt gegen jede Gegenstelle.
 *
 * **Verworfen wird der ÄLTESTE, und das ist die richtige Seite:** die Rahmen,
 * die hier landen, sind Ankündigungen, und eine neuere macht die ältere
 * gegenstandslos. Ein `hol` unter ihnen ist drüben längst in seine Frist
 * gelaufen. Ohne Grenze wäre der Vorhalt ein Speicherloch, das die Gegenstelle
 * füllt.
 *
 * **Importfrei mit Absicht** — `pnpm test:unit` fährt Nodes eingebauten Läufer,
 * und der löst einen erweiterungslosen Laufzeit-Import nicht auf.
 */

/**
 * So viele Werte werden höchstens zurückgehalten.
 *
 * Acht, weil mehr keinen Fall mehr abdeckt: die Gegenseite drosselt sich auf
 * 30 Stücke je Sekunde (`ablageDrossel.ts`), und was hier wartet, sind
 * Ankündigungen — von denen zählt ohnehin nur die letzte. Die Zahl ist eine
 * Obergrenze gegen unbegrenztes Wachsen, keine gemessene Kapazität.
 */
export const VORHALT_MAX = 8;

/** Ein kleiner Puffer mit Verdrängung des Ältesten. */
export class Vorhalt {
  #werte: unknown[] = [];
  readonly #grenze: number;

  constructor(grenze: number = VORHALT_MAX) {
    this.#grenze = Math.max(1, grenze);
  }

  /** Einen Wert zurückhalten, bis ein Ziel bekannt ist. */
  zurueckhalten(wert: unknown): void {
    this.#werte.push(wert);
    while (this.#werte.length > this.#grenze) this.#werte.shift();
  }

  /** Alles Zurückgehaltene in der Reihenfolge des Eintreffens — und leeren.
   *  Zweimal gerufen liefert der zweite Aufruf nichts. */
  abholen(): unknown[] {
    const alle = this.#werte;
    this.#werte = [];
    return alle;
  }

  /** Wegwerfen, ohne zuzustellen (Sitzungsende). */
  leeren(): void {
    this.#werte = [];
  }

  get anzahl(): number {
    return this.#werte.length;
  }
}
