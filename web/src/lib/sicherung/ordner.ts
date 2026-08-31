/**
 * Die Ordner-Helfer der Sicherung: File-System-Access-Handle wählen und
 * sein Schreibrecht prüfen/erneuern. Eigenes Modul, damit `geraete.ts`
 * unter der Größen-Policy bleibt.
 */

import { adapterAusVerzeichnis, type AblageVerzeichnis } from '../ablage/syncOrdner.ts';
import type { AblageAdapter } from '../ablage/adapter.ts';

/** Öffnet die Ordner-Auswahl (Nutzergeste) — null bei Abbruch/fehlender API. */
export async function ordnerVerzeichnisWählen(): Promise<AblageVerzeichnis | null> {
	const picker = (globalThis as unknown as {
		showDirectoryPicker?: (o?: { mode?: string }) => Promise<AblageVerzeichnis>;
	}).showDirectoryPicker;
	if (!picker) return null;
	try {
		return await picker({ mode: 'readwrite' });
	} catch (fehler) {
		if (fehler instanceof DOMException && fehler.name === 'AbortError') return null;
		throw fehler;
	}
}

/** Adapter für einen gespeicherten Ordner-Handle. */
export function ordnerAdapter(verzeichnis: AblageVerzeichnis): AblageAdapter {
	return adapterAusVerzeichnis(verzeichnis);
}

/**
 * Hat der gespeicherte Ordner-Handle DIESMAL Schreibrecht? Ohne Nutzer-
 * Geste kann hier nur geprüft, nicht angefragt werden — „prompt" heißt:
 * einmal in die Sicherungs-Einstellungen und den Knopf drücken.
 */
export async function ordnerZugriffOk(
	verzeichnis: AblageVerzeichnis,
): Promise<boolean> {
	const pruef = (verzeichnis as unknown as {
		queryPermission?: (o: { mode: string }) => Promise<string>;
	}).queryPermission;
	if (!pruef) return true; // Deckel-Alias ohne Permission-Modell
	return (await pruef.call(verzeichnis, { mode: 'readwrite' })) === 'granted';
}

/** Mit Nutzergeste (Knopf) das Schreibrecht erneut anfragen. */
export async function ordnerZugriffErneuern(
	verzeichnis: AblageVerzeichnis,
): Promise<boolean> {
	const anfrage = (verzeichnis as unknown as {
		requestPermission?: (o: { mode: string }) => Promise<string>;
	}).requestPermission;
	if (!anfrage) return true;
	return (await anfrage.call(verzeichnis, { mode: 'readwrite' })) === 'granted';
}
