/**
 * Wer gerade einen nativen Raum hält — als MENGE, nicht als Schalter.
 *
 * Zwei Dinge gelten genau so lange, wie die Hülle einen Raum hält: WebKits
 * eigene Audio-Session ist `ambient` (sonst nähme ein Oberflächen-Ton der
 * nativen Session die Routen-Hoheit, Messung an `webSessionTyp` in
 * `iosSprache.ts`), und `iosTon` fasst die Session nicht an (Bughunt
 * 2026-10-11, K2). Bis Etappe 4 gab es genau einen Halter, den Sprachkanal;
 * mit dem nativen Anruf sind es zwei, und sie laufen unabhängig. Mit einem
 * Schalter nähme das Auflegen dem Kanal WebKits Erklärung weg — dieselbe
 * Fehlerklasse, gegen die `iosTon.ts` seine Quellen als Menge führt.
 *
 * Importfrei, damit Nodes Läufer es prüfen kann (CLAUDE.md, `pnpm test:unit`).
 */
export class TonHalter {
  readonly #halter = new Set<string>();
  readonly #wechsel: (gehalten: boolean) => void;

  /** `wechsel` läuft genau beim Übergang leer ↔ nicht leer. */
  constructor(wechsel: (gehalten: boolean) => void) {
    this.#wechsel = wechsel;
  }

  setzen(halter: string, an: boolean): void {
    const vorher = this.gehalten;
    if (an) this.#halter.add(halter);
    else this.#halter.delete(halter);
    if (this.gehalten !== vorher) this.#wechsel(this.gehalten);
  }

  get gehalten(): boolean {
    return this.#halter.size > 0;
  }
}
