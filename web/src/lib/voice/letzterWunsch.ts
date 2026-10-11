/**
 * Höchstens ein Befehl unterwegs, der letzte Wunsch gewinnt — die
 * Warteschlange der Lautstärken an die Hülle (`nativeBefehle.ts`).
 *
 * Ein Regler feuert beim Ziehen Dutzende Male pro Sekunde, und die Brücke ist
 * EINE serielle Warteschlange — ihre Verstopfung hat am 2026-10-10 die App
 * einfrieren lassen (Begründung an `lautstaerken` in `nativeBefehle.ts`).
 * Deshalb geht ein Wunsch erst, wenn der vorige beantwortet ist, und von
 * allen, die in der Zwischenzeit kommen, nur der letzte.
 *
 * **Die Kette hängt an jeder Antwort.** Kommt eine nie, nimmt sie keinen
 * Wunsch mehr an — für immer, und ohne dass irgendwo ein Fehler erscheint.
 * Deshalb muss `senden` eine Frist tragen (beim Sprachweg sitzt sie in
 * `iosSprache.ts`, s. `brueckenFrist.ts`; die Wirkung ist in
 * `test/bruecken-frist.test.ts` festgehalten, samt Gegenprobe ohne Frist).
 * Ein Fehlschlag hält die Kette nicht auf; ihn zu melden ist Sache von
 * `senden`.
 *
 * Importfrei (CLAUDE.md, `pnpm test:unit`).
 */
export class LetzterWunsch<T> {
  #senden: (wert: T) => Promise<unknown>;
  #offen: { wert: T } | null = null;
  #laeuft = false;

  constructor(senden: (wert: T) => Promise<unknown>) {
    this.#senden = senden;
  }

  wuenschen(wert: T): void {
    this.#offen = { wert };
    if (!this.#laeuft) void this.#abarbeiten();
  }

  async #abarbeiten(): Promise<void> {
    this.#laeuft = true;
    try {
      while (this.#offen) {
        const { wert } = this.#offen;
        this.#offen = null;
        await this.#senden(wert).catch(() => undefined);
      }
    } finally {
      this.#laeuft = false;
    }
  }
}
