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
 *
 * Zweiter Bughunt, selbes Datum, FIX „204": `../api/client.ts::parseResponse`
 * macht aus einem koerperlosen 2xx (204 No Content — z.B. ein AELTERER
 * Server, der auf derselben Route antwortet, aber ohne den Zaehler-Body)
 * `undefined`. `ergebnis.zustellungen_angelegt` auf `undefined` WARF vorher
 * (TypeError) — der Wurf wurde im Aufrufer (`+page.svelte`) von einem
 * pauschalen `.catch(() => null)` verschluckt und als "kein Geraet
 * erreichbar" gedeutet, obwohl die verschluesselte Zustellung laengst
 * geschehen war: die Nachricht ging danach ZUSAETZLICH im Klartext raus.
 * Ein koerperloser 2xx ist aber KEIN Fehlschlag-Beweis — im Gegenteil, der
 * Server hat nicht "0 Zustellungen" gesagt, sondern schlicht keinen Zaehler
 * mitgeschickt. Ohne Gegenbeweis gilt er deshalb als zugestellt.
 */

/** Wire-Form der Antwort von `POST /postfach`
 *  (`PostfachEinliefernResponse` im Backend, `postfachApi.einliefern`).
 *  `undefined` = koerperloser 2xx (204), s. Modulkopf. */
export type PostfachEinliefernErgebnis = {
  zustellungen_angelegt: number;
  uebersprungene_empfaenger: string[];
  verworfene_nutzlasten: number;
};

/** `true`, wenn die Antwort eine Zustellung belegt oder (204) keinen
 *  Fehlschlag verneinen KANN — nur bei einem bezifferten `0` steht der
 *  Fehlschlag fest. Nur dann darf der Absender die Nachricht als gesendet
 *  behandeln. */
export function wurdeZugestellt(ergebnis: PostfachEinliefernErgebnis | undefined): boolean {
  if (ergebnis === undefined) return true;
  return ergebnis.zustellungen_angelegt > 0;
}

/**
 * Wie ein Fehlschlag beim Einliefern (`POST /postfach` wirft statt zu
 * antworten) zu deuten ist — dritter Fall desselben Bughunts, s. Modulkopf.
 * `senden.ts` ruft das mit `err.status`, wenn der Fehler ein `ApiError`
 * war (sonst gilt er ohnehin als unerwartet, s. dort).
 *
 * - 404: die Route existiert nicht — ein AELTERER Server ohne die E2E-DM-
 *   Erweiterung. Damit ist bewiesen, dass NICHTS eingeliefert werden
 *   konnte (eine nicht existierende Route nimmt nichts entgegen) — der
 *   Klartext-Rueckfall ist sicher, kein Duplikat moeglich.
 * - Alles andere (Netzwerkfehler, 5xx, Timeout, …): NICHT beweisbar
 *   folgenlos — der Server hat den Request womoeglich verarbeitet, nur die
 *   Antwort ging verloren. Ein automatischer Klartext-Rueckfall koennte
 *   hier ein Duplikat erzeugen; der Aufrufer darf deshalb NICHT
 *   stillschweigend auf `unverschluesselt` schliessen.
 */
export function deuteEinliefernFehler(status: number): 'unverschluesselt' | 'unerwartet' {
  return status === 404 ? 'unverschluesselt' : 'unerwartet';
}
