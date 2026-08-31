/**
 * Die Verbindungsprobe — eine Verbindung darf sich erst als benutzbar
 * melden, nachdem sie einmal geschrieben, gelesen, verglichen und gelöscht
 * hat. Ohne diesen Lauf legt jemand einen Kanal auf einem Laufwerk an, das
 * am Ende gar nicht schreiben kann.
 *
 * Reines Rechen-/Ablaufmodul ohne Laufzeit-Importe (nur `import type`) —
 * Nodes eingebauter Testläufer prüft diese Datei direkt, ohne Bundler.
 */

import type { AblageAdapter } from './adapter.ts';

export type ProbeSchritt = 'schreiben' | 'lesen' | 'vergleichen' | 'loeschen';

export type ProbeErgebnis =
	| { gut: true }
	| { gut: false; schritt: ProbeSchritt; grund: string };

const DATEINAME_PRAEFIX = 'pulse-probe-';
const DATEINAME_SUFFIX = '.tmp';

function zufallsHex(laenge: number): string {
	const bytes = new Uint8Array(laenge);
	globalThis.crypto.getRandomValues(bytes);
	return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function probeDateiname(): string {
	// Erkennbar am Präfix, damit ein Nutzer die Datei zuordnen kann, falls
	// das Aufräumen scheitert und sie liegen bleibt.
	return `${DATEINAME_PRAEFIX}${zufallsHex(8)}${DATEINAME_SUFFIX}`;
}

function bytesGleich(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function grundAus(fehler: unknown): string {
	return fehler instanceof Error ? fehler.message : String(fehler);
}

/**
 * Räumt die Probedatei weg. Scheitert das selbst, ist das ein eigenes
 * Ergebnis (Schritt "loeschen") — kein Fehler wird hier verschluckt.
 *
 * Adapter ohne `lösche` (z. B. ein Anbieter, der physisches Löschen gar
 * nicht anbietet) gelten als NICHT bestanden: die Probedatei bliebe
 * sichtbar im Ordner des Nutzers liegen, und genau das soll die Probe
 * verhindern — ein Laufwerk, das das nicht kann, ist für einen Kanal
 * ungeeignet, unabhängig davon, ob Schreiben/Lesen funktionieren.
 */
async function raeumeAuf(adapter: AblageAdapter, datei: string): Promise<ProbeErgebnis | null> {
	if (!adapter.lösche) {
		return {
			gut: false,
			schritt: 'loeschen',
			grund: 'Anbieter unterstützt kein physisches Löschen — die Probedatei bliebe liegen.',
		};
	}
	try {
		await adapter.lösche(datei);
		return null;
	} catch (fehler) {
		return { gut: false, schritt: 'loeschen', grund: grundAus(fehler) };
	}
}

export async function probiere(adapter: AblageAdapter): Promise<ProbeErgebnis> {
	const datei = probeDateiname();
	const inhalt = globalThis.crypto.getRandomValues(new Uint8Array(32));

	let ergebnis: ProbeErgebnis;
	try {
		await adapter.schreibe(datei, inhalt);

		let gelesen: Uint8Array | null;
		try {
			gelesen = await adapter.lese(datei);
		} catch (fehler) {
			ergebnis = { gut: false, schritt: 'lesen', grund: grundAus(fehler) };
			await raeumeAuf(adapter, datei);
			return ergebnis;
		}

		if (gelesen === null) {
			ergebnis = {
				gut: false,
				schritt: 'lesen',
				grund: 'Datei nach dem Schreiben nicht auffindbar.',
			};
			await raeumeAuf(adapter, datei);
			return ergebnis;
		}

		if (!bytesGleich(inhalt, gelesen)) {
			ergebnis = {
				gut: false,
				schritt: 'vergleichen',
				grund: 'Gelesener Inhalt weicht vom geschriebenen ab.',
			};
			await raeumeAuf(adapter, datei);
			return ergebnis;
		}
	} catch (fehler) {
		// Aufräumen wird hier bewusst nicht versucht: ist das Schreiben
		// schon gescheitert, gibt es nichts, das sicher angelegt wurde.
		return { gut: false, schritt: 'schreiben', grund: grundAus(fehler) };
	}

	const aufraeumFehler = await raeumeAuf(adapter, datei);
	if (aufraeumFehler) return aufraeumFehler;

	return { gut: true };
}
