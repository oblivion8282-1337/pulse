/**
 * Reine Rechnung fuer die Markierung „mein Archiv" (Plan-Aufgabe 2,
 * `docs/superpowers/plans/2026-08-31-ablage-e3-persoenliches-archiv.md`):
 * hoechstens EINE Verbindung darf `istArchiv` tragen. Zwei Archive
 * gleichzeitig waeren zwei Wahrheiten, und der spaetere Schreibweg
 * (Aufgabe 3) muesste raten, welche gemeint ist.
 *
 * Importfrei, wie `syncOrdnerSchluessel.ts` und `ordnerGriffEntscheidung.ts`:
 * `verbindungen.svelte.ts` legt seinen Store beim Import sofort mit
 * Svelte-Runes an, das reisst Nodes eingebauten Testlaeufer sofort ab
 * (CLAUDE.md „Die Falle"). Die Entscheidung, WELCHE Verbindung nach einem
 * Wechsel welchen Wert traegt, liegt deshalb hier — der Store schreibt nur
 * noch, was diese Funktion ihm sagt.
 */

export interface ArchivTraeger {
	id: string;
	istArchiv?: boolean;
}

export interface ArchivAenderung {
	id: string;
	istArchiv: boolean;
}

/**
 * Wird `gewaehlteId` gerade NICHT als Archiv gefuehrt, wird sie es — und
 * jede andere zuvor markierte Verbindung wird zurueckgesetzt. Trug sie die
 * Markierung schon, wird sie umgeschaltet (aus) — danach traegt KEINE
 * Verbindung mehr die Markierung, und der Verlauf faellt auf den
 * Browser-Speicher zurueck (der Normalfall, s. Modulkopf `verbindungen.svelte.ts`).
 *
 * Gibt nur die tatsaechlichen Aenderungen zurueck (Verbindungen, deren
 * `istArchiv` sich aendert) — eine unveraenderte Verbindung wird nicht
 * erneut geschrieben.
 */
export function bestimmeArchivWechsel(
	verbindungen: readonly ArchivTraeger[],
	gewaehlteId: string
): ArchivAenderung[] {
	const bisher = verbindungen.find((v) => v.id === gewaehlteId);
	// Eine unbekannte Id darf keine bestehende Markierung wegreissen, ohne
	// eine neue zu setzen — das waere ein Archiv-Verlust ohne Ersatz.
	if (!bisher) return [];
	const wirdArchiv = !(bisher.istArchiv ?? false);

	const aenderungen: ArchivAenderung[] = [];
	for (const v of verbindungen) {
		const soll = wirdArchiv && v.id === gewaehlteId;
		if ((v.istArchiv ?? false) !== soll) {
			aenderungen.push({ id: v.id, istArchiv: soll });
		}
	}
	return aenderungen;
}
