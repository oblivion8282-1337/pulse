/**
 * Selbstdrosselung des Ablage-Senders.
 *
 * **Der Gateway verwirft über 60 Signale je Sekunde STILL** (kein Fehlercode,
 * keine Antwort — `ws_remote_handlers.py::handle_signal`). Auf demselben Zähler
 * sitzen Zeigerform und Vorrang, die je Sekunde auffrischen. Ein ungebremster
 * Schwall Ablage-Stücke verschwände deshalb spurlos und sähe von aussen wie ein
 * Netzfehler aus — dieselbe Pflicht, die die Wire-Spec dem Steuernden für
 * Eingaben schon normativ auferlegt.
 *
 * **Importfrei mit Absicht** — `pnpm test:unit` fährt Nodes eingebauten Läufer,
 * und der löst einen erweiterungslosen Laufzeit-Import nicht auf.
 */

/** Höchstens so viele Stücke je Sekunde. Die Hälfte des Gateway-Deckels: die
 *  andere Hälfte gehört Zeigerform, Vorrang und dem ICE-Schwall. */
export const STUECKE_PRO_SEKUNDE = 30;

/** Ein gleitendes Ein-Sekunden-Fenster. */
export class Drossel {
  #grenze: number;
  #fensterBeginnMs = -Infinity;
  #imFenster = 0;

  constructor(proSekunde: number = STUECKE_PRO_SEKUNDE) {
    this.#grenze = proSekunde;
  }

  /**
   * Darf jetzt ein Stück hinaus? `jetztMs` wird **übergeben**, nicht selbst
   * geholt: Chromium drosselt Zeitgeber in verdeckten Fenstern auf einen Lauf
   * je Minute, und eine Drossel, die ihre eigene Uhr liest, öffnete dort nie.
   */
  darf(jetztMs: number): boolean {
    if (jetztMs - this.#fensterBeginnMs >= 1000) {
      this.#fensterBeginnMs = jetztMs;
      this.#imFenster = 0;
    }
    if (this.#imFenster >= this.#grenze) return false;
    this.#imFenster++;
    return true;
  }
}
