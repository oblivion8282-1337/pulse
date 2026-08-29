/**
 * Ob und warum das Eingabefeld eines Direktgespraechs gesperrt ist —
 * importfrei, damit sie ohne Svelte/Runes-Kompilierung pruefbar ist
 * (s. CLAUDE.md „Zwei Fallen").
 *
 * Hintergrund ist Spec §3a: **ohne App-Geraet gibt es keine
 * Direktnachrichten**. Der Klartext-Sendeweg fuer DMs faellt damit ersatzlos
 * weg, und die Regel gilt fuer beide Seiten — wer selbst eine App hat, aber
 * einer Gegenseite ohne App schreiben will, kann es ebenfalls nicht. Frueher
 * fiel dieser Fall still auf Klartext zurueck; jetzt sperrt er das
 * Eingabefeld, damit der Nutzer den Grund UND den Ausweg erfaehrt, bevor er
 * tippt.
 *
 * Drei Punkte, die die Signatur erklaeren:
 *
 * * `gespraechsStand` hat drei Zustaende (`krypto/schloss.svelte.ts::stand`).
 *   **`undefined` sperrt NICHT.** Die Auskunft ist beim Betreten des
 *   Gespraechs noch unterwegs; ein Eingabefeld, das erst gesperrt ist und
 *   gleich darauf freigibt, ist schlimmer als eines, das eine Sekunde zu
 *   spaet sperrt. Blind gesendet wird deshalb trotzdem nicht: die Autoritaet
 *   ist der Sendezeitpunkt (`krypto/senden.ts` mit frisch geholten
 *   Buendeln), und der meldet den Fehlschlag sichtbar.
 * * Der Schalter bleibt die aeussere Bedingung: solange `E2E_DMS_ENABLED`
 *   aus ist, laeuft jede DM den Klartext-Weg, und eine Sperre wegen fehlender
 *   Geraete waere schlicht falsch.
 * * `kontakt` (Freundschaft weg oder blockiert) hat Vorrang vor `ohne_app`.
 *   Treffen beide zu, nennt die Ansicht den Grund, den der Nutzer selbst
 *   aufloesen kann — die Geraetefrage der Gegenseite kann er ohnehin nicht.
 */
export type DmSendeSperre = null | 'kontakt' | 'ohne_app';

export function dmSendeSperre(
  featureSchalterEin: boolean,
  darfSenden: boolean,
  gespraechsStand: boolean | undefined
): DmSendeSperre {
  if (!darfSenden) return 'kontakt';
  if (featureSchalterEin && gespraechsStand === false) return 'ohne_app';
  return null;
}
