/**
 * Prüfsummen fürs Manifest. Läuft in Browser und Node-Testläufer, weil
 * `globalThis.crypto.subtle` in beiden zu Hause ist.
 *
 * Der einzige Import geht auf `hex.ts`, das selbst importfrei ist; die
 * Endung `.ts` ist Pflicht, weil Node einen erweiterungslosen Pfad nicht
 * auflöst (s. CLAUDE.md). Die Datei bleibt damit nach der Node-Regel prüfbar.
 *
 * `s3.ts` hatte bis zum 2026-09-01 eine zeichengleiche eigene Fassung dieser
 * Funktion und benutzt seither diese hier.
 */

import { bytesZuHex } from './hex.ts';

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const verdau = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
	return bytesZuHex(new Uint8Array(verdau));
}
