/**
 * Fernsteuerung — **Anfragen, die abgebrochen wurden, bevor ihre Kennung ankam**.
 *
 * Zwischen `remote_request` und dem `remote_pending` mit der Kennung liegt ein
 * Serverumlauf. Wer in diesem Fenster abbricht und sofort erneut anfragt,
 * bekommt die verspätete Kennung der ERSTEN Anfrage — und die Zustandsmaschine
 * erkannte die passende Anfrage nur an Ziel und Zustand, hatte also keine
 * Möglichkeit, sie von der zweiten zu unterscheiden.
 *
 * Die Folge war schlimmer als ein hängender Zustand: die alte Kennung wurde der
 * neuen Anfrage untergeschoben, und die danach eintreffende ECHTE Kennung galt
 * als fremd — sie beendete damit die gerade erst entstandene, legitime Sitzung.
 * Der Steuernde lief in „keine Antwort", der Host blieb in „wird ferngesteuert"
 * stehen.
 *
 * Eine Warteschlange und kein Zähler: so wird nur eine Kennung verworfen, die
 * WIRKLICH zum abgebrochenen Ziel gehört. Die Reihenfolge stimmt, weil beide
 * Rahmen über dieselbe Verbindung laufen.
 *
 * Herausgelöst aus `session.svelte.ts` (Grössen-Regel) — es ist reine
 * Buchführung und kennt weder Verbindung noch Sitzung.
 */

type Ziel = { channelId: string; hostUserId: string };

export class VerworfeneAnfragen {
  readonly #liste: Ziel[] = [];

  /** Ein Ziel merken, dessen Kennung noch unterwegs ist. */
  merken(channelId: string, hostUserId: string): void {
    this.#liste.push({ channelId, hostUserId });
  }

  /**
   * Gehört diese Kennung zu einer abgebrochenen Anfrage? Dann ist sie hiermit
   * verbraucht — die nächste Kennung an dasselbe Ziel gilt wieder.
   */
  verbrauchen(channelId: string, hostUserId: string): boolean {
    const i = this.#liste.findIndex(
      (v) => v.channelId === channelId && v.hostUserId === hostUserId,
    );
    if (i < 0) return false;
    this.#liste.splice(i, 1);
    return true;
  }

  /** Beim Abmelden alles fallen lassen. */
  leeren(): void {
    this.#liste.length = 0;
  }
}
