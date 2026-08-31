/**
 * Der Dateispeicher — die hochwertige Ablage-Engine für die verschlüsselte
 * Dateiablage: hochladen, auflisten, herunterladen, löschen — über jeden
 * AblageAdapter (Sync-Ordner, WebDAV, Dropbox, OneDrive, Google Drive, S3).
 *
 * Schlüsselmodell (Konzept „Kanäle mit eigener Ablage", Dateiablage-Teil):
 * ein zufälliger **Ablage-Hauptschlüssel** je Ablage-Ordner, der NUR auf den
 * Geräten der Berechtigten liegt. Jede Datei bekommt einen eigenen
 * Zufalls-Inhaltsschlüssel; der Klartext-Dateiname steckt verschlüsselt im
 * Containerkopf — auf dem Laufwerk liegt nur Kauderwelsch. Der Server sieht
 * von der Dateiablage ausschließlich die Kanalstruktur — keine Namen, keine
 * Größen, keine Bytes.
 *
 * Löschen entfernt den Eintrag aus dem Verzeichnis und die Datei vom
 * Laufwerk (wo der Adapter das anbietet — `lösche?` ist optional, vgl.
 * Sync-Ordner über `removeEntry`).
 */

import {
	DateiablageFehler,
	öffneDateiContainer,
	packeDateiContainer,
	leeresVerzeichnis,
	öffneVerzeichnis,
	verschlüsseleVerzeichnis,
	type AblageEintrag,
	type VerzeichnisDaten,
} from './dateiablage.ts';
import type { AblageAdapter } from './adapter.ts';

export const VERZEICHNIS_DATEI = 'verzeichnis.puls';

export interface DateiInfo {
	id: string;
	name: string;
	mime: string;
	groesse: number;
	hochgeladenAm: string;
	hochgeladenVon: string;
}

function zufallsHex(laenge: number): string {
	const bytes = new Uint8Array(laenge);
	globalThis.crypto.getRandomValues(bytes);
	return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class DateiSpeicher {
	private verzeichnis: VerzeichnisDaten | null = null;
	private readonly adapter: AblageAdapter;
	private readonly ordner: string;
	private readonly hauptschlüssel: Uint8Array;

	constructor(adapter: AblageAdapter, ordner: string, hauptschlüssel: Uint8Array) {
		this.adapter = adapter;
		this.ordner = ordner;
		this.hauptschlüssel = hauptschlüssel;
	}

	/** Lädt das Verzeichnis — fehlt es, ist die Ablage leer. Die Dateien
	 *  bleiben liegen, bis neue hochgeladen werden (der Sync-Client des
	 *  Anbieters räumt verwaiste Container nach seinem eigenen Zyklus ab). */
	async laden(): Promise<void> {
		const bytes = await this.adapter.lese(VERZEICHNIS_DATEI);
		if (bytes === null) {
			this.verzeichnis = { fassung: 1, einträge: [] };
			return;
		}
		this.verzeichnis = await öffneVerzeichnis(this.hauptschlüssel, bytes);
	}

	async liste(): Promise<DateiInfo[]> {
		if (this.verzeichnis === null) await this.laden();
		return (this.verzeichnis?.einträge ?? []).map((e) => ({
			id: e.id,
			name: e.name,
			mime: e.mime,
			groesse: e.groesse,
			hochgeladenAm: e.hochgeladenAm,
			hochgeladenVon: e.hochgeladenVon,
		}));
	}

	async hochladen(
		name: string,
		mime: string,
		inhalt: Uint8Array,
		hochgeladenVon: string,
	): Promise<DateiInfo> {
		if (this.verzeichnis === null) await this.laden();
		const id = zufallsHex(8);
		const dateiName = `a-${id}.puls`;
		const jetzt = new Date().toISOString();

		const container = await packeDateiContainer(
			this.hauptschlüssel,
			{
				fassung: 1,
				name,
				mime,
				groesse: inhalt.length,
				hochgeladenAm: jetzt,
				hochgeladenVon,
			},
			inhalt,
		);
		await this.adapter.schreibe(dateiName, container);

		const eintrag: AblageEintrag = {
			id,
			datei: dateiName,
			name,
			mime,
			groesse: inhalt.length,
			hochgeladenAm: jetzt,
			hochgeladenVon,
		};
		this.verzeichnis!.einträge.push(eintrag);
		await this._speichereVerzeichnis();
		return { id, name, mime, groesse: inhalt.length, hochgeladenAm: jetzt, hochgeladenVon };
	}

	async herunterladen(id: string): Promise<{ name: string; mime: string; inhalt: Uint8Array }> {
		if (this.verzeichnis === null) await this.laden();
		const eintrag = this.verzeichnis!.einträge.find((e) => e.id === id);
		if (!eintrag) throw new DateiablageFehler(`Datei ${id} ist nicht in der Ablage`);
		const container = await this.adapter.lese(eintrag.datei);
		if (container === null) {
			throw new DateiablageFehler(`Datei ${eintrag.datei} fehlt auf dem Laufwerk`);
		}
		const geöffnet = await öffneDateiContainer(this.hauptschlüssel, container);
		return {
			name: geöffnet.kopf.name,
			mime: geöffnet.kopf.mime,
			inhalt: geöffnet.inhalt,
		};
	}

	/** Löscht eine Datei aus dem Verzeichnis und — wo der Adapter das
	 *  anbietet — vom Laufwerk. Der Sync-Client des Anbieters räumt ggf.
	 *  nach seinem eigenen Zyklus ab. */
	async löschen(id: string): Promise<void> {
		if (this.verzeichnis === null) await this.laden();
		const eintrag = this.verzeichnis!.einträge.find((e) => e.id === id);
		if (!eintrag) return;
		this.verzeichnis!.einträge = this.verzeichnis!.einträge.filter((e) => e.id !== id);
		await this.adapter.lösche?.(eintrag.datei);
		await this._speichereVerzeichnis();
	}

	async _speichereVerzeichnis(): Promise<void> {
		const bytes = await verschlüsseleVerzeichnis(this.hauptschlüssel, this.verzeichnis!);
		await this.adapter.schreibe(VERZEICHNIS_DATEI, bytes);
	}
}

export type { AblageEintrag } from './dateiablage.ts';
