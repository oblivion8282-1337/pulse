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

/**
 * Wie viele Stücke eine einzelne Lieferung höchstens hat.
 *
 * **Spiegelzahl** von `pulse_ablage::stueckelung::MAX_STUECKE` (dort aus
 * `MAX_TEXT_BYTE / MAX_STUECK_ROH + 1` gerechnet). Sie hier noch einmal
 * auszurechnen hiesse, zwei statt einer Zahl zu spiegeln; ändert sich drüben
 * eine der beiden Grenzen, muss diese von Hand nachgezogen werden.
 */
export const STUECKE_JE_LIEFERUNG = 12;

/**
 * Ein gleitendes Ein-Sekunden-Fenster mit **Nachsicht für eine ganze
 * Lieferung**.
 *
 * Der Deckel gilt im Mittel, nicht hart: über die Grenze hinaus lässt die
 * Drossel noch bis zu [`STUECKE_JE_LIEFERUNG`] Stücke durch und zieht sie dem
 * nächsten Fenster wieder ab. **Grund: eine Lieferung ist unteilbar.** Fällt
 * ein einzelnes ihrer Stücke, ist nicht ein Stück weg, sondern die ganze
 * Lieferung — der Sammler drüben wartet auf ein Stück, das nie kommt, bis
 * `ABRUF_FRIST_MS` (2 s) abläuft, und auf Windows und macOS **steht das
 * einfügende Programm diese 2 s**. Ein kurzer Schwall über dem eigenen Deckel
 * ist der deutlich kleinere Preis, zumal er dem Gateway-Deckel (60) nicht
 * nahekommt.
 */
export class Drossel {
  #grenze: number;
  #nachsicht: number;
  #fensterBeginnMs = -Infinity;
  #imFenster = 0;
  /** Was das laufende Fenster über sein Soll hinaus durchgelassen hat. */
  #geliehen = 0;

  constructor(
    proSekunde: number = STUECKE_PRO_SEKUNDE,
    nachsicht: number = STUECKE_JE_LIEFERUNG,
  ) {
    this.#grenze = proSekunde;
    this.#nachsicht = nachsicht;
  }

  /**
   * Darf jetzt ein Stück hinaus? `jetztMs` wird **übergeben**, nicht selbst
   * geholt: Chromium drosselt Zeitgeber in verdeckten Fenstern auf einen Lauf
   * je Minute, und eine Drossel, die ihre eigene Uhr liest, öffnete dort nie.
   */
  darf(jetztMs: number): boolean {
    if (jetztMs - this.#fensterBeginnMs >= 1000) {
      this.#fensterBeginnMs = jetztMs;
      // **Geliehen, nicht geschenkt:** das neue Fenster beginnt mit dem
      // Vorschuss belastet, damit der Mittelwert bei der Grenze bleibt.
      // Gedeckelt auf die Grenze, damit ein Fenster nie schon geschlossen
      // anfängt — sonst könnte eine Lieferung die nächste aussperren.
      this.#imFenster = Math.min(this.#geliehen, this.#grenze);
      this.#geliehen = 0;
    }
    if (this.#imFenster >= this.#grenze + this.#nachsicht) return false;
    if (this.#imFenster >= this.#grenze) this.#geliehen++;
    this.#imFenster++;
    return true;
  }
}
