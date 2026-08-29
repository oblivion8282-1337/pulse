/**
 * Der verfallene Browser loescht seinen lokalen Verlauf — die Entscheidung
 * darueber, und nur sie.
 *
 * Importfrei, damit Nodes eingebauter Testlaeufer sie ohne Bundler prueft
 * (s. CLAUDE.md „Zwei Fallen"); die Anbindung an Netz und IndexedDB steht in
 * `verfallPruefen.ts` daneben.
 *
 * **Die eine Regel, an der hier alles haengt: geloescht wird NUR auf ein
 * eindeutiges Signal hin, niemals auf einen Fehlschlag.** Ein Netzwerkfehler,
 * ein 500er, eine abgelaufene Anmeldung, ein Server, der die Route noch nicht
 * kennt — all das heisst „ich weiss es nicht", nicht „verfallen". Der lokale
 * Verlauf ist die einzige Kopie (der Server hat keine, das ist der Sinn der
 * Ende-zu-Ende-Verschluesselung), ein falsches Loeschen also unumkehrbar.
 * Genau diese Verwechslung — ein voruebergehender Fehler als endgueltiger
 * Zustand gedeutet — hat im sechsten Bughunt Klartext verschickt.
 *
 * Deshalb ist die Antwort des Servers dreiwertig (`routes/schluessel_
 * auskunft.py::geraetestand`): `verfallen` loescht, `gueltig` und `unbekannt`
 * tun nichts. `unbekannt` ist ausdruecklich KEIN Verfall — es ist der frische
 * Browser (der nichts zu loeschen hat) und die durch die Geraete-Obergrenze
 * verdraengte Zeile, zwei Faelle, die man nicht auseinanderhalten kann.
 *
 * Und die Richtung des Zweifels ist absichtlich unsymmetrisch: im Zweifel
 * bleibt der Verlauf liegen. Ein Verfall, der eine Sitzung zu spaet greift,
 * kostet nichts — ein Loeschen, das nicht haette sein duerfen, ist endgueltig.
 */

/** Was `GET /keys/geraetestand` antwortet. Als Rohtext angenommen, nicht als
 *  Union getypt: was ueber die Leitung kommt, ist zur Laufzeit ein `string`,
 *  und ein unbekannter Wert (neuere Serverfassung) darf hier nicht als
 *  „verfallen" durchrutschen. */
export type GeraetestandAntwort = { stand?: unknown };

/** Das einzige Wort, das loescht. Als Konstante, damit ein Tippfehler an der
 *  Vergleichsstelle nicht still zu „loescht nie" oder „loescht immer" wird. */
export const VERFALLEN = 'verfallen';

/**
 * Ob diese Antwort ein Verfall ist. Alles andere — anderer Wert, fehlendes
 * Feld, kein String — ist es nicht.
 */
export function istVerfallsSignal(antwort: GeraetestandAntwort | null | undefined): boolean {
  return antwort?.stand === VERFALLEN;
}

/**
 * Der ganze Ablauf, mit hereingereichten Abhaengigkeiten — damit genau das
 * pruefbar ist, worauf es ankommt: dass ein FEHLSCHLAG nichts loescht.
 *
 * `holen` darf werfen (Netz weg, 401, 503, kaputte Antwort). Der `catch`
 * unten ist deshalb kein Schoenheitsfehler, sondern die eigentliche Aussage
 * dieser Funktion: ein Fehler beim Fragen ist keine Antwort.
 *
 * Gibt zurueck, ob geloescht wurde — der Aufrufer haengt daran seinen Hinweis
 * an den Nutzer.
 */
export async function verfallAbarbeiten(
  holen: () => Promise<GeraetestandAntwort>,
  verlaufLoeschen: () => Promise<void>,
  melden?: () => void
): Promise<boolean> {
  let antwort: GeraetestandAntwort;
  try {
    antwort = await holen();
  } catch {
    return false;
  }
  if (!istVerfallsSignal(antwort)) return false;

  // Ab hier ist der Verfall festgestellt. Scheitert das Loeschen selbst
  // (IndexedDB nicht verfuegbar, privates Fenster), wird NICHT gemeldet: der
  // Verlauf liegt dann noch da, und ein Hinweis „geloescht" waere falsch. Der
  // naechste Start fragt erneut — der Grabstein am Server klebt.
  await verlaufLoeschen();
  melden?.();
  return true;
}
