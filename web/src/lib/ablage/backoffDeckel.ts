/**
 * Backoff mit Deckel — geteilt von `festigung.ts` und `kanalFestigung.ts`
 * (Modulköpfe dort: "Deckel-Backoff (Muster aus `festigung.ts`)"). Beide
 * brauchten bislang eine wortgleiche Kopie aus zwei `Map`s + drei Funktionen;
 * hier einmal, damit eine künftige Änderung an der Formel nicht an zwei
 * Stellen nachgezogen werden muss.
 *
 * Bewusst NICHT persistiert (kein IndexedDB, reiner Arbeitsspeicher je
 * Prozess) — ein Neuladen der Seite startet bei 0. Das ist an beiden
 * Aufrufstellen unschädlich, weil der nächste periodische Durchlauf ohnehin
 * wieder jeden offenen Eintrag sieht (Begründung dort, nicht hier wiederholt).
 */

export interface BackoffDeckel {
	/** Erhöht den Fehlversuchszähler und sperrt bis zum nächsten Backoff-Ziel. */
	vermerkeFehlschlag(schluessel: string): void;
	/** Löscht Zähler und Sperre — der nächste Versuch ist wieder sofort fällig. */
	vermerkeErfolg(schluessel: string): void;
	/** Ist die Sperrfrist (falls eine läuft) abgelaufen? */
	istFaellig(schluessel: string): boolean;
}

/**
 * `maxBackoffMs`: Obergrenze der Verdopplung (`1_000 * 2 ** versuche`),
 * Vorgabe 5 Minuten — an beiden bisherigen Aufrufstellen unverändert übernommen.
 */
export function backoffDeckel(maxBackoffMs = 5 * 60_000): BackoffDeckel {
	const versuche = new Map<string, number>();
	const gesperrtBis = new Map<string, number>();

	return {
		vermerkeFehlschlag(schluessel) {
			const n = (versuche.get(schluessel) ?? 0) + 1;
			versuche.set(schluessel, n);
			const verzoegerung = Math.min(1_000 * 2 ** n, maxBackoffMs);
			gesperrtBis.set(schluessel, Date.now() + verzoegerung);
		},
		vermerkeErfolg(schluessel) {
			versuche.delete(schluessel);
			gesperrtBis.delete(schluessel);
		},
		istFaellig(schluessel) {
			const bis = gesperrtBis.get(schluessel);
			return bis === undefined || bis <= Date.now();
		}
	};
}
