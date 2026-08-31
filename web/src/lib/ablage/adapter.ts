/**
 * Die Ablage-Schnittstelle: alles, was der Schreiber und der Leser über den
 * Speicher wissen dürfen. Jeder Anbieter (Sync-Ordner über File-System-Access,
 * WebDAV, App-Folder-OAuth, S3) steckt hinter dieser Reihe, und beide
 * Arbeitsweisen prüfen gegen den Gedächtnis-Adapter in Tests.
 *
 * Das optionale `lösche` erlaubt physisches Entfernen — ohne es bleibt die
 * Datei als verschlüsselter Rest liegen (Grabstein im Verzeichnis).
 */

export interface AblageAdapter {
	/** Überschreibt die Datei vollständig — die Ablage kennt kein echtes Anhängen. */
	schreibe(datei: string, inhalt: Uint8Array): Promise<void>;
	/** Liest die Datei, oder null, wenn sie fehlt. */
	lese(datei: string): Promise<Uint8Array | null>;
	/** Alle Dateinamen des Ablage-Ordners (nur Namen, keine Pfade). */
	liste(): Promise<string[]>;
	/** Löscht eine Datei physisch — optional; Implementierungen ohne
	 *  physisches Löschen lassen den verschlüsselten Rest liegen. */
	lösche?(datei: string): Promise<void>;
}

/** Reiner Speicher im Arbeitsfeld — für Tests und als Rückfall für Prüfungen. */
export function speicherAdapter(): AblageAdapter & { inhalte: Map<string, Uint8Array> } {
	const inhalte = new Map<string, Uint8Array>();
	return {
		inhalte,
		async schreibe(datei, inhalt) {
			inhalte.set(datei, inhalt.slice());
		},
		async lese(datei) {
			return inhalte.get(datei) ?? null;
		},
		async liste() {
			return [...inhalte.keys()];
		},
		async lösche(datei) {
			inhalte.delete(datei);
		},
	};
}
