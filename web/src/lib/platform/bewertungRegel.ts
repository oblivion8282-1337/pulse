/**
 * Wann die System-Bewertungsfrage gestellt werden darf.
 *
 * **Warum eine Regel und nicht einfach „nach dem Senden":** iOS zeigt die
 * Frage höchstens dreimal im Jahr je Nutzer und sagt nie, ob sie erschienen
 * ist. Jeder Aufruf verbraucht also ein knappes Kontingent, blind. Wer bei
 * jedem Senden fragt, verschiesst es in der ersten Minute — und zwar genau
 * dann, wenn der Nutzer die App noch gar nicht kennt und am ehesten schlecht
 * bewertet.
 *
 * Deshalb: erst nach einer Weile echter Nutzung, und danach nie wieder von
 * selbst. Die Zahl ist bewusst nüchtern gewählt — wer zwanzig Nachrichten
 * geschrieben hat, benutzt Pulse, statt es anzusehen.
 *
 * Importfrei, damit Nodes Testläufer die Regel prüfen kann (s. CLAUDE.md).
 */

export const SENDUNGEN_BIS_ZUR_FRAGE = 20;

export interface Bewertungsstand {
  /** Erfolgreich gesendete Nachrichten, über alle Sitzungen gezählt. */
  gesendet: number;
  /** Wurde schon einmal gefragt? */
  bereitsGefragt: boolean;
}

export function sollFragen(stand: Bewertungsstand): boolean {
  if (stand.bereitsGefragt) return false;
  return stand.gesendet >= SENDUNGEN_BIS_ZUR_FRAGE;
}
