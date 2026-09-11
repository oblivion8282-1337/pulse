/**
 * Die eine Liste der Ablage-Anbieter.
 *
 * Vorher zaehlte jede Anzeigestelle sie selbst auf — der Verbinden-Dialog,
 * die Einstellungs-Sektion, die Adapter-Weiche, dazu zwei getrennte
 * Verbindungs-Stores mit je eigener `AblageAnbieterArt`. Bei so einer
 * Streuung ist die naechste hinzugefuegte Stelle die, die es vergisst.
 *
 * **Was hier NICHT steht:** wie man sich verbindet. Das bleibt Sache der
 * Adapter (`dropbox.ts`, `gdrive.ts`, `webdav.ts`, `syncOrdner.ts`). Diese
 * Datei beantwortet nur zwei Fragen: welche Anbieter die Oberflaeche
 * anbietet, und welche davon fuer einen Kanal taugen.
 *
 * Importfrei in Sachen Anbieter-Logik — das Feature-Flag kommt aus
 * `featureFlags.ts` (Build-Konstante ohne Importe, testläufer-sicher).
 */

import { ABLAGE_FREMDE_ANBIETER_ENABLED } from '../featureFlags.ts';

export type AblageAnbieterArt =
	| 'dropbox'
	| 'onedrive'
	| 'gdrive'
	| 'nextcloud'
	| 'pulse'
	| 'sync_ordner'
	| 's3';

export interface AnbieterEintrag {
	art: AblageAnbieterArt;
	/** Wie er in der Oberflaeche heisst. */
	name: string;
	/** Wird er zur Auswahl angeboten? Siehe `NICHT_ANGEBOTEN` unten. */
	angeboten: boolean;
	/**
	 * Liefert er eine Adresse, unter der ANDERE das verschluesselte Archiv
	 * abrufen koennen?
	 *
	 * Das entscheidet, ob ein Kanal darauf liegen darf (Entwurf §2.2): ein
	 * Kanal, dessen Inhalt niemand ausser dem Ersteller erreichen kann, ist
	 * fuer die Mitglieder kein Kanal. Ein lokaler Ordner ohne Sync-Client hat
	 * keine solche Adresse — deshalb steht `sync_ordner` hier auf `false`,
	 * obwohl er fuer das persoenliche Archiv das Beste ist, was es gibt.
	 */
	fuerKanaele: boolean;
}

/**
 * Warum OneDrive und S3 nicht angeboten werden (Entscheidung des
 * Eigentuemers, 2026-08-31): OneDrive ist gebaut und unit-geprueft, aber nie
 * echt gelaufen — der Zugang braucht ein Azure-Konto mit Kartenpruefung. S3
 * hat eine zu schmale Zielgruppe, um die Pflege zu rechtfertigen. Beide
 * Adapter bleiben im Baum; nachziehen kostet dann nur diese Zeile.
 *
 * Seit dem 2026-09-11 sind ALLE fremden Anbieter geparkt
 * (`ABLAGE_FREMDE_ANBIETER_ENABLED`, Produktentscheidung „Pulse vermietet
 * Speicher statt fremde Clouds einzubinden“) — die Liste hier beschreibt
 * nur noch den eingeschalteten Zustand. Das Pulse-Laufwerk steht NICHT in
 * dieser Liste: es ist kein Dialog-Anbieter mit Konfiguration, sondern wird
 * direkt in der Community-Ablage verbunden (`CommunityDateiablage.svelte`).
 */
export const ANBIETER: readonly AnbieterEintrag[] = [
	{ art: 'gdrive', name: 'Google Drive', angeboten: true, fuerKanaele: true },
	{ art: 'nextcloud', name: 'Nextcloud', angeboten: true, fuerKanaele: true },
	{ art: 'dropbox', name: 'Dropbox', angeboten: true, fuerKanaele: true },
	{ art: 'sync_ordner', name: 'Ordner auf diesem Gerät', angeboten: true, fuerKanaele: false },
	{ art: 'onedrive', name: 'OneDrive', angeboten: false, fuerKanaele: true },
	{ art: 's3', name: 'S3-kompatibel', angeboten: false, fuerKanaele: true },
];

/** Die Anbieter, die die Oberflaeche zur Auswahl stellt — seit dem
 *  2026-09-11 nur noch der Sync-Ordner, solange die fremden geparkt sind
 *  (`ABLAGE_FREMDE_ANBIETER_ENABLED`). */
export function angeboteneAnbieter(): AnbieterEintrag[] {
	return ANBIETER.filter(
		(a) => a.angeboten && (ABLAGE_FREMDE_ANBIETER_ENABLED || a.art === 'sync_ordner')
	);
}

/** Die Anbieter, auf denen ein Kanal liegen darf. */
export function kanalTaugliche(): AnbieterEintrag[] {
	return ANBIETER.filter((a) => a.angeboten && a.fuerKanaele && ABLAGE_FREMDE_ANBIETER_ENABLED);
}

/** Nachschlagen; `undefined` fuer eine unbekannte Art. */
export function anbieter(art: string): AnbieterEintrag | undefined {
	return ANBIETER.find((a) => a.art === art);
}
