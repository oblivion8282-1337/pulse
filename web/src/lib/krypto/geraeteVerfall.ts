/**
 * Wann ein Geraet seinen lokalen Verlauf loescht — die Entscheidung, und nur
 * sie.
 *
 * Importfrei, damit Nodes eingebauter Testlaeufer sie ohne Bundler prueft
 * (s. CLAUDE.md „Zwei Fallen"); die Anbindung an Netz und IndexedDB steht in
 * `verfallPruefen.ts` daneben.
 *
 * **Zwei Gruende, eine Abfrage.** Der Dateiname nennt nur den aelteren der
 * beiden: den 14-Tage-Verfall eines gekoppelten Browsers (Spec §3a). Seit dem
 * 2026-08-30 kommt der Ausschluss durch den Kontoinhaber dazu (Spec §3b
 * Punkt 4, „Geraet entfernen"). Beide beantwortet dieselbe Route,
 * `GET /keys/geraetestand`, und das ist Absicht: es ist ein und dieselbe
 * Frage — darf dieses Geraet noch? —, die derselbe Klient an derselben Stelle
 * stellt. Eine zweite Abfrage daneben waere eine zweite Gelegenheit, sie
 * falsch zu beantworten, und die Folge einer falschen Antwort ist hier
 * unumkehrbar.
 *
 * **Die eine Regel, an der alles haengt: geloescht wird NUR auf ein
 * eindeutiges Signal hin, niemals auf einen Fehlschlag.** Ein Netzwerkfehler,
 * ein 500er, eine abgelaufene Anmeldung, ein Server, der die Route noch nicht
 * kennt — all das heisst „ich weiss es nicht", nicht „verfallen". Der lokale
 * Verlauf ist die einzige Kopie (der Server hat keine, das ist der Sinn der
 * Ende-zu-Ende-Verschluesselung), ein falsches Loeschen also unumkehrbar.
 * Genau diese Verwechslung — ein voruebergehender Fehler als endgueltiger
 * Zustand gedeutet — hat im sechsten Bughunt Klartext verschickt.
 *
 * Deshalb ist die Antwort des Servers mehrwertig (`routes/schluessel_
 * auskunft.py::geraetestand`): `verfallen` und `entfernt` loeschen, `gueltig`
 * und `unbekannt` tun nichts. `unbekannt` ist ausdruecklich KEIN Verfall — es
 * ist der frische Browser (der nichts zu loeschen hat) und die durch die
 * Geraete-Obergrenze verdraengte Zeile, zwei Faelle, die man nicht
 * auseinanderhalten kann.
 *
 * Und die Richtung des Zweifels ist absichtlich unsymmetrisch: im Zweifel
 * bleibt der Verlauf liegen. Ein Verfall, der eine Sitzung zu spaet greift,
 * kostet nichts — ein Loeschen, das nicht haette sein duerfen, ist endgueltig.
 */

/** Was `GET /keys/geraetestand` antwortet. Als Rohtext angenommen, nicht als
 *  Union getypt: was ueber die Leitung kommt, ist zur Laufzeit ein `string`,
 *  und ein unbekannter Wert (neuere Serverfassung) darf hier nicht als
 *  Loeschbefehl durchrutschen. */
export type GeraetestandAntwort = { stand?: unknown };

/** Das Geraet war 14 Tage ungenutzt (Spec §3a). */
export const VERFALLEN = 'verfallen';
/** Der Kontoinhaber hat dieses Geraet aus seiner Geraeteliste geworfen
 *  (Spec §3b Punkt 4). */
export const ENTFERNT = 'entfernt';

/** Die beiden Woerter, die loeschen. Als Konstanten, damit ein Tippfehler an
 *  der Vergleichsstelle nicht still zu „loescht nie" oder „loescht immer"
 *  wird. */
export type LoeschGrund = typeof VERFALLEN | typeof ENTFERNT;

/**
 * Der Grund, aus dem dieses Geraet loeschen muss — oder `null`.
 *
 * Alles andere (anderer Wert, fehlendes Feld, kein String) ist `null`. Die
 * Aufzaehlung steht hier ausdruecklich und wird nicht aus dem Wert abgeleitet:
 * ein kuenftiger fuenfter Serverwert soll nichts ausloesen, bis jemand
 * entschieden hat, was er bedeutet.
 */
export function loeschGrund(
  antwort: GeraetestandAntwort | null | undefined
): LoeschGrund | null {
  if (antwort?.stand === VERFALLEN) return VERFALLEN;
  if (antwort?.stand === ENTFERNT) return ENTFERNT;
  return null;
}

/**
 * Der ganze Ablauf, mit hereingereichten Abhaengigkeiten — damit genau das
 * pruefbar ist, worauf es ankommt: dass ein FEHLSCHLAG nichts loescht.
 *
 * `holen` darf werfen (Netz weg, 401, 503, kaputte Antwort). Der `catch`
 * unten ist deshalb kein Schoenheitsfehler, sondern die eigentliche Aussage
 * dieser Funktion: ein Fehler beim Fragen ist keine Antwort.
 *
 * Gibt den Grund zurueck, aus dem geloescht wurde, sonst `null` — der
 * Aufrufer haengt daran seinen Hinweis an den Nutzer, und der Hinweis ist je
 * Grund ein anderer: „abgelaufen" waere an einem gerade entfernten Geraet
 * schlicht falsch.
 */
export async function geraetestandAbarbeiten(
  holen: () => Promise<GeraetestandAntwort>,
  verlaufLoeschen: () => Promise<void>,
  melden?: (grund: LoeschGrund) => void
): Promise<LoeschGrund | null> {
  let antwort: GeraetestandAntwort;
  try {
    antwort = await holen();
  } catch {
    return null;
  }
  const grund = loeschGrund(antwort);
  if (grund === null) return null;

  // Ab hier steht der Grund fest. Scheitert das Loeschen selbst (IndexedDB
  // nicht verfuegbar, privates Fenster), wird NICHT gemeldet: der Verlauf
  // liegt dann noch da, und ein Hinweis „geloescht" waere falsch. Der
  // naechste Start fragt erneut — beide Grabsteine am Server kleben.
  await verlaufLoeschen();
  melden?.(grund);
  return grund;
}
