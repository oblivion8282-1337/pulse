/**
 * Bytes als Hex — die eine Stelle.
 *
 * Die Abbildung `b.toString(16).padStart(2, '0')` stand bis zum 2026-09-01
 * fuenfmal wortgleich im Ablage-Baum: zweimal als privates `zufallsHex`
 * (`probe.ts`, `dateispeicher.ts`, zeichengleich), in `pruefsumme.ts` und
 * in `s3.ts` als je ein `sha256Hex` — diese beiden ebenfalls zeichengleich,
 * bis auf nichts — und einmal in `s3.ts` unverpackt in der SigV4-Signatur.
 *
 * Das `padStart(2, '0')` ist der Grund, warum sich das Zusammenlegen lohnt
 * und nicht nur Zeilen spart: ohne die Auffuellung faellt aus jedem Byte
 * unter 0x10 eine Stelle weg, und die Zeichenkette wird kuerzer als 2n
 * Zeichen. In `s3.ts` traefe das die SigV4-Signatur selbst.
 *
 * **Wie oft, ausgerechnet statt geschaetzt:** ein Byte ist mit 16/256 unter
 * 0x10, eine Signatur hat 32 Bytes — 1 − (15/16)^32 ≈ **87 %**. Es waere
 * also nicht der seltene Sonderfall, nach dem eine fehlende Auffuellung
 * aussieht, sondern etwa sieben von acht Anfragen. Und weil jede Anfrage
 * eine andere Signatur hat, faellt es NICHT reproduzierbar aus, sondern
 * sprunghaft — die teuerste Form, in der ein Fehler auftreten kann.
 * Ein solcher Fehler tritt in einer Kopie auf und in den anderen nicht.
 *
 * Importfrei (s. CLAUDE.md zur Falle bei `pnpm test:unit`).
 */

/** Kleinbuchstaben-Hex, immer zwei Zeichen je Byte. */
export function bytesZuHex(bytes: Uint8Array): string {
	return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `laenge` Zufallsbytes als Hex — also `2 * laenge` Zeichen. */
export function zufallsHex(laenge: number): string {
	const bytes = new Uint8Array(laenge);
	globalThis.crypto.getRandomValues(bytes);
	return bytesZuHex(bytes);
}
