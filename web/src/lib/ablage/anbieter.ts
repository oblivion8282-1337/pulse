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
 * Importfrei (s. CLAUDE.md zur Falle bei `pnpm test:unit`).
 */

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
 * Diese Liste ist die AUSWAHL FUERS PERSOENLICHE ARCHIV (Sicherung der
 * eigenen Nachrichten) — Festlegung vom 2026-09-11: fremde Anbieter
 * (Dropbox, Google Drive, Nextcloud) und der Sync-Ordner gehoeren NUR hierhin,
 * fuer alles andere (Communitys) nicht. Dort gibt es ausschliesslich das
 * Pulse-Laufwerk (``PULSE_ANBIETER``), das eben deshalb nicht in dieser
 * Liste steht. Das Ablage-Kanalspiel (E7, ``fuerKanaele``) bleibt wie
 * beschrieben bei den fremden Anbietern.
 */
export const ANBIETER: readonly AnbieterEintrag[] = [
	{ art: 'gdrive', name: 'Google Drive', angeboten: true, fuerKanaele: true },
	{ art: 'nextcloud', name: 'Nextcloud', angeboten: true, fuerKanaele: true },
	{ art: 'dropbox', name: 'Dropbox', angeboten: true, fuerKanaele: true },
	{ art: 'sync_ordner', name: 'Ordner auf diesem Gerät', angeboten: true, fuerKanaele: false },
	{ art: 'onedrive', name: 'OneDrive', angeboten: false, fuerKanaele: true },
	{ art: 's3', name: 'S3-kompatibel', angeboten: false, fuerKanaele: true },
];

/**
 * Das Pulse-Laufwerk — der SPEICHER FUR COMMUNITYS (Eigentuemer-Entscheidung
 * 2026-09-11): der einzige Anbieter, den die Community-Ablage im
 * Verbinden-Dialog zeigt. Fuer das persoenliche Archiv ist er bewusst NICHT
 * waehlbar — dort bleibt es beim eigenen Ordner und den eigenen Clouds.
 */
export const PULSE_ANBIETER: AnbieterEintrag = {
	art: 'pulse',
	name: 'Pulse-Laufwerk',
	angeboten: true,
	fuerKanaele: true,
};

/** Die Anbieter, die die Oberflaeche zur Auswahl stellt — das ist die
 *  Archiv-Auswahl (s. Listen-Kopf). */
export function angeboteneAnbieter(): AnbieterEintrag[] {
	return ANBIETER.filter((a) => a.angeboten);
}

/** Die Anbieter, auf denen ein Kanal liegen darf. */
export function kanalTaugliche(): AnbieterEintrag[] {
	return ANBIETER.filter((a) => a.angeboten && a.fuerKanaele);
}

/** Die Auswahl fuer das LAUFWERK EINER COMMUNITY — ausschliesslich das
 *  Pulse-Laufwerk (Festlegung 2026-09-11, s. PULSE_ANBIETER). */
export function communityAnbieter(): AnbieterEintrag[] {
	return [PULSE_ANBIETER];
}

/** Nachschlagen; `undefined` fuer eine unbekannte Art. */
export function anbieter(art: string): AnbieterEintrag | undefined {
	return ANBIETER.find((a) => a.art === art);
}
