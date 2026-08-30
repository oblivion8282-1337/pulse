/**
 * Der Schreiber — das einzige Bauteil, das in die Ablage hineinschreibt.
 * Er trägt die Absturz-Reihenfolge des Konzepts: erst das Segment, zuletzt
 * das Manifest; geht zwischen beiden etwas verloren, adoptiert
 * `bestandAufnehmen` die verwaiste Segmentdatei beim nächsten Start.
 *
 * Phase 1 füttert der Aufrufer von außen (der Krypto-Nachzug tauscht die
 * Quelle: Postfach statt `GET /channels/{id}/messages`). Der Schreiber
 * selbst kennt weder REST noch Krypto — Nutzlasten sind opake Bytes.
 */

import {
	type Rahmen,
	kodiereRahmenFolge,
	leseRahmenFolge,
	TYP_KLARTEXT_JSON,
} from './format.ts';
import {
	baueSegment,
	leseSegmentKopf,
	segDateiName,
	segIndexAusName,
	SegmentFehler,
	SEGMENT_KOPF_LAENGE,
} from './segment.ts';
import {
	MANIFEST_DATEI,
	erstelleManifest,
	manifestAusDaten,
	manifestMitSegment,
	verwaisteSegmente,
	type AblageManifest,
	type SegmentEintrag,
} from './manifest.ts';
import { sha256Hex } from './pruefsumme.ts';
import type { AblageAdapter } from './adapter.ts';

export interface AblageEintrag {
	/** Snowflake der Nachricht — gibt dem Log seine Ordnung. */
	id: bigint;
	nutzlast: Uint8Array;
	typ?: number;
}

export interface FestigungErgebnis {
	segmentIndex: number;
	rahmen: number;
}

export interface NachzugBericht {
	adoptiert: string[];
	uebersprungen: string[];
	/** true, wenn das Manifest fehlte oder unlesbar war und neu gebaut wurde. */
	neuGebaut: boolean;
}

/** Zielgröße: ein Segment rollt weiter, wenn es darüber liegt. */
export const SEGMENT_BYTE_ZIEL = 1024 * 1024;

export class AblageFehler extends Error {
	constructor(meldung: string) {
		super(meldung);
		this.name = 'AblageFehler';
	}
}
// Keine Parameter-Properties in dieser Datei — siehe Hinweis in manifest.ts.

/** Ein aus einer Datei zurückgelesener Eintrag samt bereinigter Bytes. */
interface GelesenesSegment {
	eintrag: SegmentEintrag;
	/** Nicht-null, wenn die Datei hinter dem lesbaren Anfang Müll trägt und neu geschrieben werden muss. */
	bereinigt: Uint8Array | null;
}

export class AblageSchreiber {
	private manifest: AblageManifest | null = null;
	private readonly adapter: AblageAdapter;
	private readonly kanalId: string;
	private readonly segmentByteZiel: number;

	constructor(
		adapter: AblageAdapter,
		kanalId: string,
		segmentByteZiel: number = SEGMENT_BYTE_ZIEL,
	) {
		this.adapter = adapter;
		this.kanalId = kanalId;
		this.segmentByteZiel = segmentByteZiel;
	}

	stand(): AblageManifest | null {
		return this.manifest;
	}

	/**
	 * Nimmt den Ablage-Bestand auf: Manifest laden — fehlt es oder ist es
	 * unlesbar, aus den Segmenten neu bauen — und verwaiste Segmentdateien
	 * adoptieren, die der letzte Absturz hinter dem Manifest zurückließ.
	 * Prüft zusätzlich das letzte (offene) Segment gegen seine Prüfsumme,
	 * weil genau dort eine gekappte Schreiboperation landet.
	 */
	async bestandAufnehmen(): Promise<NachzugBericht> {
		const bericht: NachzugBericht = { adoptiert: [], uebersprungen: [], neuGebaut: false };
		const dateien = await this.adapter.liste();

		let manifest = await this.ladeManifest();
		if (manifest === null) {
			bericht.neuGebaut = true;
			manifest = erstelleManifest(this.kanalId);
		} else {
			manifest = await this.berichtigeOffenesSegment(manifest, bericht);
		}

		const waisen = verwaisteSegmente(manifest, dateien)
			.map(segIndexAusName)
			.filter((i): i is number => i !== null)
			.sort((a, b) => a - b);
		for (const index of waisen) {
			const datei = segDateiName(index);
			const gelesen = await this.leseSegment(datei, index);
			if (gelesen === null) {
				bericht.uebersprungen.push(datei);
				continue;
			}
			try {
				if (gelesen.bereinigt !== null) {
					await this.adapter.schreibe(datei, gelesen.bereinigt);
				}
				manifest = manifestMitSegment(manifest, gelesen.eintrag);
				bericht.adoptiert.push(datei);
			} catch {
				bericht.uebersprungen.push(datei);
			}
		}

		this.manifest = manifest;
		if (bericht.adoptiert.length > 0 || bericht.neuGebaut) {
			await this.schreibeManifest(manifest);
		}
		return bericht;
	}

	/**
	 * Hängt Einträge ans Log. Ids müssen streng aufsteigend sein und hinter
	 * dem Ablage-Stand liegen — das Log ist ein Verlauf, kein Zettelkasten.
	 * Liefert null, wenn nichts zu tun war.
	 */
	async festigen(eintraege: AblageEintrag[]): Promise<FestigungErgebnis | null> {
		if (eintraege.length === 0) {
			return null;
		}
		if (this.manifest === null) {
			await this.bestandAufnehmen();
		}
		const manifest = this.manifest!;
		let vorige = manifest.letzteId !== null ? BigInt(manifest.letzteId) : null;
		for (const eintrag of eintraege) {
			if (vorige !== null && eintrag.id <= vorige) {
				throw new AblageFehler(
					`Eintrag ${eintrag.id} liegt nicht hinter dem Ablage-Stand ${vorige}`,
				);
			}
			vorige = eintrag.id;
		}

		const basis = await this.schreibBasis(manifest, eintraege);

		const neueRahmen: Rahmen[] = eintraege.map((e) => ({
			typ: e.typ ?? TYP_KLARTEXT_JSON,
			eintragsId: e.id,
			nutzlast: e.nutzlast,
		}));
		const rahmenBytes = kodiereRahmenFolge(neueRahmen);
		const vollstaendig = new Uint8Array(
			basis.alteRahmenBytes.length + rahmenBytes.length,
		);
		vollstaendig.set(basis.alteRahmenBytes, 0);
		vollstaendig.set(rahmenBytes, basis.alteRahmenBytes.length);
		const dateiBytes = baueSegment(basis.index, vollstaendig);

		// Erst die Segmentdatei, zuletzt das Manifest — siehe Klassenkopf.
		await this.adapter.schreibe(basis.datei, dateiBytes);
		const neuerEintrag: SegmentEintrag = {
			index: basis.index,
			datei: basis.datei,
			rahmen: basis.alteRahmen + neueRahmen.length,
			bytes: dateiBytes.length,
			pruefsumme: await sha256Hex(dateiBytes),
			ersteId: basis.ersteId,
			letzteId: eintraege[eintraege.length - 1].id.toString(),
		};
		this.manifest = manifestMitSegment(manifest, neuerEintrag);
		await this.schreibeManifest(this.manifest);
		return { segmentIndex: basis.index, rahmen: neueRahmen.length };
	}

	/**
	 * Worauf der nächste Batch schreibt: aufs offene (letzte) Segment, solange
	 * es unter der Zielgröße liegt und sein Kopf noch stimmt — sonst auf ein
	 * frisches Segment dahinter.
	 */
	private async schreibBasis(
		manifest: AblageManifest,
		eintraege: AblageEintrag[],
	): Promise<{
		index: number;
		datei: string;
		ersteId: string;
		alteRahmen: number;
		alteRahmenBytes: Uint8Array;
	}> {
		const letzte = manifest.segmente[manifest.segmente.length - 1];
		if (letzte !== undefined && letzte.bytes < this.segmentByteZiel) {
			const alteDatei = await this.adapter.lese(letzte.datei);
			if (alteDatei !== null && this.kopfWennPassend(alteDatei, letzte.index)) {
				return {
					index: letzte.index,
					datei: letzte.datei,
					ersteId: letzte.ersteId,
					alteRahmen: letzte.rahmen,
					alteRahmenBytes: alteDatei.slice(SEGMENT_KOPF_LAENGE),
				};
			}
		}
		const index = (letzte?.index ?? -1) + 1;
		return {
			index,
			datei: segDateiName(index),
			ersteId: eintraege[0].id.toString(),
			alteRahmen: 0,
			alteRahmenBytes: new Uint8Array(0),
		};
	}

	private async ladeManifest(): Promise<AblageManifest | null> {
		const bytes = await this.adapter.lese(MANIFEST_DATEI);
		if (bytes === null) {
			return null;
		}
		try {
			return manifestAusDaten(JSON.parse(new TextDecoder().decode(bytes)));
		} catch {
			return null;
		}
	}

	/**
	 * Das höchste Segment ist das offene — dort landet eine gekappte
	 * Schreiboperation. Weicht die Datei von der Prüfsumme ab, wird der
	 * Eintrag aus dem lesbaren Anfang neu bestimmt und die Datei bereinigt.
	 */
	private async berichtigeOffenesSegment(
		manifest: AblageManifest,
		bericht: NachzugBericht,
	): Promise<AblageManifest> {
		const letzte = manifest.segmente[manifest.segmente.length - 1];
		if (letzte === undefined) {
			return manifest;
		}
		const bytes = await this.adapter.lese(letzte.datei);
		if (bytes === null || (await sha256Hex(bytes)) === letzte.pruefsumme) {
			return manifest;
		}
		const gelesen = await this.leseSegment(letzte.datei, letzte.index);
		if (gelesen === null) {
			throw new AblageFehler(
				`Offenes Segment ${letzte.datei} ist unlesbar und kann nicht berichtigt werden`,
			);
		}
		if (gelesen.bereinigt !== null) {
			await this.adapter.schreibe(letzte.datei, gelesen.bereinigt);
		}
		bericht.uebersprungen.push(`${letzte.datei} (berichtigt)`);
		return manifestMitSegment(manifest, gelesen.eintrag);
	}

	/**
	 * Liest eine Segmentdatei und fasst ihren lesbaren Anfang als Eintrag
	 * zusammen. Trägt die Datei hinter dem lesbaren Anfang Müll (gekappte
	 * Schreiboperation), liefert `bereinigt` die neu zu schreibenden Bytes —
	 * sonst bliebe der Müll stehen und jedes spätere Anhängen bräche die
	 * Prüfsumme des Eintrags.
	 */
	private async leseSegment(datei: string, erwartetIndex: number): Promise<GelesenesSegment | null> {
		const bytes = await this.adapter.lese(datei);
		if (bytes === null) {
			return null;
		}
		try {
			if (leseSegmentKopf(bytes).index !== erwartetIndex) {
				return null;
			}
		} catch (fehler) {
			if (fehler instanceof SegmentFehler) {
				return null;
			}
			throw fehler;
		}
		const { rahmen, abbruch } = leseRahmenFolge(bytes.slice(SEGMENT_KOPF_LAENGE));
		if (rahmen.length === 0) {
			return null;
		}
		if (abbruch === null) {
			return {
				eintrag: {
					index: erwartetIndex,
					datei,
					rahmen: rahmen.length,
					bytes: bytes.length,
					pruefsumme: await sha256Hex(bytes),
					ersteId: rahmen[0].eintragsId.toString(),
					letzteId: rahmen[rahmen.length - 1].eintragsId.toString(),
				},
				bereinigt: null,
			};
		}
		const lesbar = baueSegment(erwartetIndex, kodiereRahmenFolge(rahmen));
		return {
			eintrag: {
				index: erwartetIndex,
				datei,
				rahmen: rahmen.length,
				bytes: lesbar.length,
				pruefsumme: await sha256Hex(lesbar),
				ersteId: rahmen[0].eintragsId.toString(),
				letzteId: rahmen[rahmen.length - 1].eintragsId.toString(),
			},
			bereinigt: lesbar,
		};
	}

	private kopfWennPassend(bytes: Uint8Array, erwartetIndex: number): boolean {
		try {
			return leseSegmentKopf(bytes).index === erwartetIndex;
		} catch (fehler) {
			if (fehler instanceof SegmentFehler) {
				return false;
			}
			throw fehler;
		}
	}

	private async schreibeManifest(manifest: AblageManifest): Promise<void> {
		await this.adapter.schreibe(
			MANIFEST_DATEI,
			new TextEncoder().encode(JSON.stringify(manifest)),
		);
	}
}
