/**
 * Sync-Ordner-Adapter: die Ablage ist ein Verzeichnis, das der Sync-Client
 * des Owners in seine Cloud trägt (Dropbox-, Drive-, OneDrive-, Nextcloud-
 * Client — egal). Kein Anbieter-API, kein Token bei uns: der Owner nutzt
 * seinen eigenen Client mit seinem eigenen Konto. Das Verzeichnis wird über
 * die File-System-Access-API angesprochen, wie im lokalen Medien-Archiv —
 * Desktop-App und Chromium-Browser können das.
 *
 * Die minimalen Struktur-Typen hier unten bewusst selbst definiert statt
 * aus lib.dom geerbt: die FS-Access-Typen dort sind lückenhaft, und der
 * Adapter soll nicht an eine Fassung gebunden sein.
 */

import type { AblageAdapter } from './adapter.ts';

interface SchreibbareDatei {
	write(inhalt: Uint8Array): Promise<void>;
	close(): Promise<void>;
}

interface DateiHandle {
	createWritable(): Promise<SchreibbareDatei>;
	getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
}

export interface AblageVerzeichnis {
	getFileHandle(name: string, optionen?: { create?: boolean }): Promise<DateiHandle>;
	removeEntry(name: string): Promise<void>;
	entries(): AsyncIterable<[string, { kind: string }]>;
}

/** File-System-Access ist da? (Secure Context vorausgesetzt.) */
export function syncOrdnerMoeglich(): boolean {
	return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export function adapterAusVerzeichnis(verzeichnis: AblageVerzeichnis): AblageAdapter {
	return {
		async schreibe(datei, inhalt) {
			const handle = await verzeichnis.getFileHandle(datei, { create: true });
			const schreibbar = await handle.createWritable();
			try {
				await schreibbar.write(inhalt);
			} finally {
				await schreibbar.close();
			}
		},
		async lese(datei) {
			try {
				const handle = await verzeichnis.getFileHandle(datei);
				const inhalt = await (await handle.getFile()).arrayBuffer();
				return new Uint8Array(inhalt);
			} catch {
				// Fehlende Datei ist hier ein normaler Zustand, kein Fehler.
				return null;
			}
		},
		async liste() {
			const namen: string[] = [];
			for await (const [name, eintrag] of verzeichnis.entries()) {
				if (eintrag.kind === 'file') {
					namen.push(name);
				}
			}
			return namen;
		},
		async lösche(datei) {
			await verzeichnis.removeEntry(datei);
		},
	};
}
