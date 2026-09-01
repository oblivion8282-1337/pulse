/**
 * Stuft einen vom ABSENDER gewaehlten MIME-Typ herunter, bevor daraus eine
 * `blob:`-Adresse wird.
 *
 * Der Typ eines Anhangs kommt aus dem verschluesselten Kopf, den der Absender
 * geschrieben hat (`attachments/uploadVerschluesselt.ts`), und der Server
 * sieht ihn absichtlich nie — es gibt also keine Stelle ausser dieser, an der
 * er geprueft werden koennte.
 *
 * **Heute entsteht daraus kein Schaden**, und das soll ehrlich dastehen: Die
 * Oberflaeche schickt Bilder in ein `<img>` (dort fuehrt kein Browser das
 * Skript in einer SVG aus) und alles Uebrige in einen Link mit
 * `download`-Attribut, das Speichern erzwingt statt zu navigieren. Die
 * Absicherung ist damit aber **implizit**: Sie haengt am Elementtyp und am
 * Vorhandensein genau dieses Attributs. Faellt das `download` einmal weg —
 * ein fehlender Dateiname genuegt —, navigiert der Klick auf die
 * `blob:`-Adresse, und ein Anhang mit `text/html` liefe als Skript im
 * Ursprung der Anwendung. Diese Datei macht die Absicherung ausdruecklich,
 * damit ein spaeterer Umbau sie nicht stillschweigend aufhebt.
 *
 * **`image/svg+xml` steht bewusst NICHT auf der Liste.** Eine SVG wird nur
 * ueber `<img>` angezeigt, und dort ist sie unschaedlich; sie
 * herunterzustufen wuerde die Vorschau kaputtmachen, ohne etwas zu gewinnen.
 * Wer SVG jemals in ein `<iframe>`, `<object>` oder eine Navigation gibt,
 * muss sie hier eintragen — und diesen Absatz mit aendern.
 *
 * Importfrei (s. CLAUDE.md zur Falle bei `pnpm test:unit`), damit Nodes
 * eingebauter Testlaeufer sie direkt prueft.
 */

/** Der Ersatztyp: laesst den Browser nichts deuten, nur speichern. */
export const NEUTRALER_TYP = 'application/octet-stream';

/**
 * Typen, die ein Browser als Dokument im eigenen Ursprung ausfuehren wuerde,
 * sobald man zu ihnen navigiert. Bewusst kurz gehalten: jede Zeile hier ist
 * eine Vorschau, die es danach nicht mehr gibt.
 */
const GEFAEHRLICH = new Set([
	'text/html',
	'application/xhtml+xml',
	'text/xml',
	'application/xml',
	'text/xsl',
	'application/xslt+xml',
]);

/**
 * Liefert den Typ, mit dem der Blob gebaut werden darf.
 *
 * Leer, unbekannt oder gefaehrlich ergibt `NEUTRALER_TYP`; alles Uebrige
 * bleibt unveraendert.
 */
export function sichererBlobTyp(typ: string | null | undefined): string {
	if (!typ) return NEUTRALER_TYP;
	// `text/html; charset=utf-8` und `TEXT/HTML` sind derselbe Typ — ohne
	// Abschneiden der Parameter und ohne Kleinschreibung liefe die Liste ins
	// Leere, und genau daran scheitern solche Listen ueblicherweise.
	const nackt = typ.split(';')[0].trim().toLowerCase();
	if (nackt === '') return NEUTRALER_TYP;
	return GEFAEHRLICH.has(nackt) ? NEUTRALER_TYP : nackt;
}
