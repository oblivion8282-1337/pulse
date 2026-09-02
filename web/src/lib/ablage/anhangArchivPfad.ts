/**
 * Wie ein verschlüsselter DM-Anhang im persönlichen Archiv heisst
 * (Design §11.1) — importfrei, damit Nodes eingebauter Testläufer die Form
 * ohne Bundler prüft (s. CLAUDE.md „Zwei Fallen").
 *
 * **Das ist die einzige Stelle, an der sich Server und Klient einig sein
 * müssen, ohne je miteinander darüber zu reden.** Der Server schreibt die
 * Datei beim Versenden in den Archiv-Ordner jedes Beteiligten
 * (`ablage_anhang_verteilung.py::archiv_pfad`); der Klient sucht sie später
 * dort. Es wandert kein Pfad über die Leitung — beide leiten ihn aus der
 * Anhang-Kennung ab. Laufen die beiden Ableitungen auseinander, schreibt der
 * Server an eine Stelle, an der niemand nachsieht, und **nirgends wird etwas
 * rot**: der Klient fällt still auf den Pulse-Weg zurück, der nach der
 * Verteilung keine Bytes mehr hat. Deshalb steht die Form auf beiden Seiten
 * in einem Test.
 *
 * **Flach, ohne Unterordner.** Ein `PUT` in eine WebDAV-Sammlung, die es noch
 * nicht gibt, wird mit 409 beantwortet, und der Schreibweg legt bewusst keine
 * an. Der Archiv-Ordner trägt seine Segmente ohnehin flach
 * (`segment.ts`: `seg-000000.puls`); das Präfix `anh-` hält die beiden Sorten
 * auseinander.
 *
 * **Im Namen steht nur die Kennung** — kein Dateiname, kein Typ, keine
 * Grösse. Der echte Name liegt im verschlüsselten Umschlag beim Empfänger und
 * geht den Server nichts an; er könnte ihn hier auch gar nicht hinschreiben.
 */

/** Der Dateiname des Anhangs (oder seines Vorschaubildes) im Archiv-Ordner. */
export function anhangArchivPfad(anhangId: string, vorschau = false): string {
	return `anh-${anhangId}${vorschau ? '-vs' : ''}.puls`;
}
