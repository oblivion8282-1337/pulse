/**
 * Geduld bei 429 — ein Aufruf, der an der Ratenbegrenzung des Servers
 * abprallt, wird nach steigenden Pausen wiederholt.
 *
 * Gebraucht von den Archiv-Routen (`archivAdapter.ts`): die Sicherung
 * schreibt bei der Erstsicherung Dutzende Dateien in einem Schub, und der
 * Server begrenzt je Nutzer und Minute. Ohne Geduld blieb ab dem ersten
 * 429 alles Weitere im Puffer hängen und der Nutzer sah eine Fehlermeldung
 * für eine Verbindung, die stand (Dev-Stack, 2026-09-02).
 *
 * Nur 429 wird wiederholt. Ein 5xx oder Netzfehler bleibt, was er ist —
 * dafür haben die Aufrufer ihre eigenen Wege (Puffer, Rückfall).
 *
 * Importfrei, damit Nodes eingebauter Testläufer die Datei ohne Bundler
 * prüft (s. CLAUDE.md „Die Falle").
 */

/** Pausen zwischen den Versuchen in Millisekunden — nach der letzten wird
 *  der Fehler weitergereicht. Die Summe (31 s) liegt knapp über dem
 *  Minutenfenster des Servers, damit ein voller Eimer sicher leer wird. */
export const PAUSEN_MS: readonly number[] = [1000, 2000, 4000, 8000, 16000];

export function istRatenbegrenzt(fehler: unknown): boolean {
	return (
		typeof fehler === 'object' &&
		fehler !== null &&
		(fehler as { status?: unknown }).status === 429
	);
}

export async function mitGeduldBei429<T>(
	versuch: () => Promise<T>,
	schlafen: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
	pausen: readonly number[] = PAUSEN_MS
): Promise<T> {
	for (let i = 0; ; i++) {
		try {
			return await versuch();
		} catch (fehler) {
			if (!istRatenbegrenzt(fehler) || i >= pausen.length) throw fehler;
			await schlafen(pausen[i]);
		}
	}
}
