/**
 * Reine Rechnung: gilt die Antwort von `POST /postfach` als Erfolg? —
 * importfrei, damit Nodes eingebauter Testlaeufer sie ohne Bundler prueft
 * (s. CLAUDE.md „Die Falle"). Ausgelagert aus `senden.ts`, das die Antwort
 * selbst nicht importfrei halten kann (Netzwerk-Client, Krypto-Kern).
 *
 * Bughunt 2026-08-28, FIX 2: eine 2xx-Antwort von `POST /postfach` ist FUER
 * SICH kein Beweis, dass die Nachricht irgendwo ankam — der Server darf
 * jeden angefragten Empfaenger einzeln uebersprungen haben (unbekanntes
 * Buendel, Kontingent voll, s. `PostfachEinliefernResponse`-Docstring im
 * Backend). Erst wenn mindestens EINE Zustellung tatsaechlich entstand, hat
 * die Nachricht ihr Ziel erreicht.
 */

/** Wire-Form der Antwort von `POST /postfach`
 *  (`PostfachEinliefernResponse` im Backend, `postfachApi.einliefern`). */
export type PostfachEinliefernErgebnis = {
  zustellungen_angelegt: number;
  uebersprungene_empfaenger: string[];
  verworfene_nutzlasten: number;
};

/** `true`, wenn mindestens eine Zustellung entstand — nur dann darf der
 *  Absender die Nachricht als gesendet behandeln. */
export function wurdeZugestellt(ergebnis: PostfachEinliefernErgebnis): boolean {
  return ergebnis.zustellungen_angelegt > 0;
}
