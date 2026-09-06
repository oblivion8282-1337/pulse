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
 * Löschen entfernt den Eintrag aus dem Verzeichnis und die Datei physisch
 * vom Laufwerk. `lösche?` bleibt im Adapter-Vertrag optional, weil der
 * Gedächtnis-Adapter in Tests keinen echten Datenträger hat — jeder
 * angebotene Anbieter (Sync-Ordner, WebDAV, Dropbox, Google Drive) setzt es
 * um.
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
import { zufallsHex } from './hex.ts';

export const VERZEICHNIS_DATEI = 'verzeichnis.puls';

export interface DateiInfo {
	id: string;
	name: string;
	mime: string;
	groesse: number;
	hochgeladenAm: string;
	hochgeladenVon: string;
}

export class DateiSpeicher {
	private verzeichnis: VerzeichnisDaten | null = null;
	private readonly adapter: AblageAdapter;
	private readonly ordner: string;
	private readonly hauptschlüssel: Uint8Array;
	/** Reihe für alles, was das Verzeichnis liest UND wieder schreibt. */
	private kette: Promise<unknown> = Promise.resolve();

	/**
	 * Führt `tun` erst aus, wenn die vorige eingereihte Arbeit fertig ist.
	 *
	 * Der Grund ist ein Lesen-Ändern-Schreiben ohne Sperre: zwei gleichzeitige
	 * `hochladen`-Aufrufe hängen beide an dieselbe Liste an, serialisieren
	 * aber jeder für sich und schreiben jeder für sich. Kommen die beiden
	 * Schreibvorgänge in umgekehrter Reihenfolge an, überschreibt der ältere
	 * Stand den neueren, und ein Eintrag ist weg. Der verschlüsselte Container
	 * bleibt dabei auf dem Laufwerk liegen, nur zeigt kein Verzeichnis mehr
	 * auf ihn — für den Nutzer ist die Datei kommentarlos verschwunden, und es
	 * gibt hier (anders als bei den Nachrichten-Segmenten, wo
	 * `bestandAufnehmen` Waisen adoptiert) keinen Nachzug, der das heilt.
	 *
	 * Die Reihe läuft auch nach einem Fehlschlag weiter: ein gescheiterter
	 * Upload darf die Ablage nicht für den Rest der Sitzung blockieren.
	 */
	private nacheinander<T>(tun: () => Promise<T>): Promise<T> {
		const laufend = this.kette.then(tun, tun);
		this.kette = laufend.then(
			() => undefined,
			() => undefined,
		);
		return laufend;
	}

	/** Lädt nur, wenn noch nichts da ist. Ohne eigene Sperre — die Aufrufer
	 *  stehen bereits in der Reihe (`nacheinander`). */
	private async _ladenWennNoetig(): Promise<void> {
		if (this.verzeichnis === null) await this.laden();
	}

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
		return this.nacheinander(() => this._liste());
	}

	private async _liste(): Promise<DateiInfo[]> {
		await this._ladenWennNoetig();
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
		const id = zufallsHex(8);
		const dateiName = `a-${id}.puls`;
		const jetzt = new Date().toISOString();

		const container = await packeDateiContainer(
			this.hauptschlüssel,
			{
				name,
				mime,
				groesse: inhalt.length,
				hochgeladenAm: jetzt,
				hochgeladenVon,
			} as Parameters<typeof packeDateiContainer>[1],
			inhalt,
		);
		// Der Container traegt einen eigenen, zufaelligen Namen und kollidiert
		// mit nichts — er darf ausserhalb der Reihe geschrieben werden, damit
		// zwei Uploads ihre Bytes weiter gleichzeitig hochschieben. In die
		// Reihe gehoert nur, was das GEMEINSAME Verzeichnis anfasst.
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
		return this.nacheinander(async () => {
			await this._ladenWennNoetig();
			this.verzeichnis!.einträge.push(eintrag);
			await this._speichereVerzeichnis();
			return { id, name, mime, groesse: inhalt.length, hochgeladenAm: jetzt, hochgeladenVon };
		});
	}

	async herunterladen(id: string): Promise<{ name: string; mime: string; inhalt: Uint8Array }> {
		// Nur das Nachschlagen steht in der Reihe; das Herunterladen der Bytes
		// laeuft daneben weiter, sonst blockierte eine grosse Datei jeden
		// Upload.
		const eintrag = await this.nacheinander(async () => {
			await this._ladenWennNoetig();
			return this.verzeichnis!.einträge.find((e) => e.id === id);
		});
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
		return this.nacheinander(async () => {
			await this._ladenWennNoetig();
			const eintrag = this.verzeichnis!.einträge.find((e) => e.id === id);
			if (!eintrag) return;
			this.verzeichnis!.einträge = this.verzeichnis!.einträge.filter((e) => e.id !== id);
			await this.adapter.lösche?.(eintrag.datei);
			await this._speichereVerzeichnis();
		});
	}

	/**
	 * Schreibt einen BEREITS gepackten Container (aus ``dateiablage.ts::
	 * packeDateiContainer``) direkt aufs Laufwerk und traegt ihn ins
	 * Verzeichnis ein — ohne erneut zu verschluesseln. Fuer die Festigung
	 * (``festigung.ts``): das Mitglied hat den Container schon verschluesselt
	 * und ins Zwischenlager gelegt; das Besitzer-Geraet holt exakt diese
	 * Bytes und muss sie nur noch platzieren. ``kopf`` kommt aus
	 * ``öffneDateiContainer`` (derselbe Aufruf, mit dem das Besitzer-Geraet
	 * den Klumpen ohnehin oeffnet, um den Verzeichniseintrag zu bauen) — der
	 * Inhalt bleibt dabei die ganze Zeit Chiffrat, nur der Kopf wird kurz
	 * entschluesselt, NIE der Inhalt selbst.
	 */
	async festigeVorverschlüsseltenContainer(
		id: string,
		container: Uint8Array,
		kopf: { name: string; mime: string; groesse: number; hochgeladenAm: string; hochgeladenVon: string },
	): Promise<void> {
		const dateiName = `a-${id}.puls`;
		await this.adapter.schreibe(dateiName, container);
		const eintrag: AblageEintrag = { id, datei: dateiName, ...kopf };
		return this.nacheinander(async () => {
			await this._ladenWennNoetig();
			// Idempotent: ein wiederholter Festigungsversuch (z. B. nach einem
			// Absturz zwischen Schreiben und Quittieren) darf denselben Eintrag
			// kein zweites Mal anhaengen.
			if (this.verzeichnis!.einträge.some((e) => e.id === id)) return;
			this.verzeichnis!.einträge.push(eintrag);
			await this._speichereVerzeichnis();
		});
	}

	async _speichereVerzeichnis(): Promise<void> {
		const bytes = await verschlüsseleVerzeichnis(this.hauptschlüssel, this.verzeichnis!);
		await this.adapter.schreibe(VERZEICHNIS_DATEI, bytes);
	}
}

export type { AblageEintrag } from './dateiablage.ts';
