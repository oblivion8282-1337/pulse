/**
 * Der Schreiber — das einzige Bauteil, das in die Ablage hineinschreibt.
 * Er trägt die Absturz-Reihenfolge des Konzepts: erst das Segment, zuletzt
 * das Manifest; geht zwischen beiden etwas verloren, adoptiert der Nachzug
 * (nachzug.ts) die verwaiste Segmentdatei beim nächsten Start.
 *
 * Phase 1 füttert der Aufrufer von außen (der Krypto-Nachzug tauscht die
 * Quelle: Postfach statt `GET /channels/{id}/messages`). Der Schreiber
 * selbst kennt weder REST noch Krypto — Nutzlasten sind opake Bytes.
 */

import { type Rahmen, kodiereRahmenFolge, RAHMEN_KOPF_LAENGE, TYP_KLARTEXT_JSON } from './format.ts';
import { baueSegment, leseSegmentKopf, segDateiName, SegmentFehler, SEGMENT_KOPF_LAENGE } from './segment.ts';
import {
	MANIFEST_DATEI,
	manifestMitSegment,
	type AblageManifest,
} from './manifest.ts';
import { sha256Hex } from './pruefsumme.ts';
import type { AblageAdapter } from './adapter.ts';
import { AblageFehler, nimmBestandAuf, type NachzugBericht } from './nachzug.ts';

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

/** Zielgröße: ein Segment rollt weiter, wenn es darüber liegt. */
export const SEGMENT_BYTE_ZIEL = 1024 * 1024;

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
	 * Nimmt den Ablage-Bestand auf — Delegat an den Nachzug, der verwaiste
	 * Segmente adoptiert und das offene Segment berichtigt.
	 */
	async bestandAufnehmen(): Promise<NachzugBericht> {
		const { manifest, bericht } = await nimmBestandAuf(this.adapter, this.kanalId);
		this.manifest = manifest;
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
		let manifest = this.manifest!;
		let vorige = manifest.letzteId !== null ? BigInt(manifest.letzteId) : null;
		for (const eintrag of eintraege) {
			if (vorige !== null && eintrag.id <= vorige) {
				throw new AblageFehler(
					`Eintrag ${eintrag.id} liegt nicht hinter dem Ablage-Stand ${vorige}`,
				);
			}
			vorige = eintrag.id;
		}

		const rahmen: Rahmen[] = eintraege.map((e) => ({
			typ: e.typ ?? TYP_KLARTEXT_JSON,
			eintragsId: e.id,
			nutzlast: e.nutzlast,
		}));
		const groessen = rahmen.map((r) => RAHMEN_KOPF_LAENGE + r.nutzlast.length);

		// Die Partie wandert in Segment-gerechten Happen aufs offene Segment:
		// ein Rahmen teilt sich nie, aber ein einzelner Riese bekommt sein
		// eigenes Segment. Das Manifest schreibt einmal am Ende — geht der
		// Lauf vorher kaputt, adoptiert der Nachzug die verwaisten Segmente
		// (deren Kette stimmt, denn die Ids steigen ja).
		let bei = 0;
		let letzterIndex = -1;
		while (bei < rahmen.length) {
			const basis = await this.schreibBasis(manifest, rahmen[bei].eintragsId.toString());
			let stueckBytes = basis.alteRahmenBytes.length;
			let bis = bei;
			while (bis < rahmen.length) {
				const mitNaechstem = stueckBytes + groessen[bis];
				if (bis > bei && mitNaechstem > this.segmentByteZiel) {
					break;
				}
				stueckBytes = mitNaechstem;
				bis++;
			}
			const stueck = kodiereRahmenFolge(rahmen.slice(bei, bis));
			const vollstaendig = new Uint8Array(stueckBytes);
			vollstaendig.set(basis.alteRahmenBytes, 0);
			vollstaendig.set(stueck, basis.alteRahmenBytes.length);
			const dateiBytes = baueSegment(basis.index, vollstaendig);

			// Erst die Segmentdatei, zuletzt das Manifest — siehe Klassenkopf.
			await this.adapter.schreibe(basis.datei, dateiBytes);
			manifest = manifestMitSegment(manifest, {
				index: basis.index,
				datei: basis.datei,
				rahmen: basis.alteRahmen + (bis - bei),
				bytes: dateiBytes.length,
				pruefsumme: await sha256Hex(dateiBytes),
				ersteId: basis.ersteId,
				letzteId: rahmen[bis - 1].eintragsId.toString(),
			});
			letzterIndex = basis.index;
			bei = bis;
		}
		this.manifest = manifest;
		await this.schreibeManifest(manifest);
		return { segmentIndex: letzterIndex, rahmen: rahmen.length };
	}

	/**
	 * Worauf der nächste Happen schreibt: aufs offene (letzte) Segment,
	 * solange es unter der Zielgröße liegt und sein Kopf noch stimmt — sonst
	 * auf ein frisches Segment dahinter.
	 */
	private async schreibBasis(
		manifest: AblageManifest,
		ersteIdFrisch: string,
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
			ersteId: ersteIdFrisch,
			alteRahmen: 0,
			alteRahmenBytes: new Uint8Array(0),
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
