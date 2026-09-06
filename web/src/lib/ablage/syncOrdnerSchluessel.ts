/**
 * Reine Entscheidung fuer den Ablage-Hauptschluessel des Sync-Ordners: gibt
 * es schon eine Verbindung mit der festen ID `SYNC_ORDNER_VERBINDUNGS_ID`,
 * wird ihr Schluessel wiederverwendet — sonst wird aus frischen Zufallsbytes
 * einer erzeugt, den der Aufrufer dann in `verbindungen.ts` persistiert.
 *
 * Kein IndexedDB-, kein `$state`-Zugriff hier: `verbindungen.ts` legt seinen
 * Store beim Import sofort an (`new AblageVerbindungsStore()`, oben in der
 * Datei) und benutzt dabei Svelte-Runes, die es ausserhalb der
 * Svelte-Kompilierung nicht gibt — ein Import dieser Datei in Nodes
 * eingebautem Testlaeufer wirft sofort (CLAUDE.md „Die Falle"). Die
 * eigentliche Rechnung — wiederverwenden oder neu erzeugen — liegt deshalb
 * hier, importfrei und ohne Browser-Abhaengigkeit.
 */

export const SYNC_ORDNER_VERBINDUNGS_ID = 'sync-ordner';

export interface HauptschluesselTraeger {
	hauptschlüsselB64: string;
}

export function bytesZuBase64(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

export function base64ZuBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

export interface SyncOrdnerSchlüsselErgebnis {
	hauptschlüssel: Uint8Array;
	hauptschlüsselB64: string;
	/** true, wenn `hauptschlüssel` neu erzeugt wurde und noch nicht im Store liegt. */
	istNeu: boolean;
}

/**
 * `bestehend`: die Verbindung mit `SYNC_ORDNER_VERBINDUNGS_ID`, falls sie im
 * Store schon existiert. `zufallsBytes`: 32 frische Zufallsbytes fuer den
 * Fall, dass es noch keine Verbindung gibt — vom Aufrufer erzeugt, damit
 * diese Funktion ohne `crypto` auskommt und deterministisch testbar bleibt.
 */
export function bestimmeSyncOrdnerHauptschlüssel(
	bestehend: HauptschluesselTraeger | undefined,
	zufallsBytes: Uint8Array
): SyncOrdnerSchlüsselErgebnis {
	if (bestehend) {
		return {
			hauptschlüssel: base64ZuBytes(bestehend.hauptschlüsselB64),
			hauptschlüsselB64: bestehend.hauptschlüsselB64,
			istNeu: false
		};
	}
	return {
		hauptschlüssel: zufallsBytes,
		hauptschlüsselB64: bytesZuBase64(zufallsBytes),
		istNeu: true
	};
}
