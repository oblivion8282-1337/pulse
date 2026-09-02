/**
 * Ordner-Pfade der Sicherung auf EINE Ebene abflachen — für Ziele, die über
 * den Pulse-Server laufen.
 *
 * Die Sicherung legt je Unterhaltung einen Ordner an
 * (`<kanalId>/dev-…-seg-000001.puls`, s. `spiegel.ts::ordnerAdapter`). Der
 * Google-Adapter und der lokale Ordner tragen das; die Archiv-Routen des
 * Servers (`/ablage/archiv/*`) nicht: `liste` fragt nur die oberste Ebene
 * ab und lässt Ordner weg, und `schreibe` legt keinen fehlenden Ordner an
 * (WebDAV verlangt dafür ein eigenes `MKCOL`). Statt beide Routen um
 * Ordner-Logik zu erweitern, tauscht dieser Adapter den Schrägstrich
 * gegen ein Zeichen, das in keinem Sicherungs-Namen vorkommt — nach
 * aussen sieht die Sicherung ihre gewohnten Ordner, im Laufwerk liegt
 * alles nebeneinander. Ein Archiv, das so entstanden ist, liest sich über
 * denselben Adapter auf jedem Gerät zurück.
 *
 * `~` ist gewählt, weil Kanal-Ids Ziffern sind und Segment-, Schlüssel- und
 * Anhang-Namen nur aus `[a-z0-9.-]` bestehen; ein echtes `~` in einem
 * Namen wird deshalb abgewiesen statt still umgedeutet.
 *
 * Importfrei, damit Nodes eingebauter Testläufer die Datei ohne Bundler
 * prüft (s. CLAUDE.md „Die Falle").
 */

export const FLACH_TRENNER = '~';

export function flachName(pfad: string): string {
	if (pfad.includes(FLACH_TRENNER)) {
		throw new Error(`Sicherung: Name enthält das Ordner-Ersatzzeichen: ${pfad}`);
	}
	return pfad.split('/').join(FLACH_TRENNER);
}

export function tiefName(flach: string): string {
	return flach.split(FLACH_TRENNER).join('/');
}

/** Das Mindestmaß eines Adapters, das die Abflachung braucht. */
interface FlachBasis {
	schreibe(datei: string, inhalt: Uint8Array): Promise<void>;
	lese(datei: string): Promise<Uint8Array | null>;
	liste(): Promise<string[]>;
	lösche?(datei: string): Promise<void>;
}

export function flachAdapter<A extends FlachBasis>(
	basis: A
): A & { lösche(datei: string): Promise<void> } {
	return {
		...basis,
		schreibe: (datei: string, inhalt: Uint8Array) => basis.schreibe(flachName(datei), inhalt),
		lese: (datei: string) => basis.lese(flachName(datei)),
		liste: async () => (await basis.liste()).map(tiefName),
		lösche: async (datei: string) => {
			if (basis.lösche) await basis.lösche(flachName(datei));
		}
	};
}
