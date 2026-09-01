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

import {
	type Rahmen,
	kodiereRahmenFolge,
	leseRahmenFolge,
	RAHMEN_KOPF_LAENGE,
	TYP_KLARTEXT_JSON,
} from './format.ts';
import { baueSegment, leseSegmentKopf, segDateiName, SegmentFehler, SEGMENT_KOPF_LAENGE } from './segment.ts';
import {
	MANIFEST_DATEI,
	manifestMitSegment,
	type AblageManifest,
} from './manifest.ts';
import { sha256Hex } from './pruefsumme.ts';
import type { AblageAdapter } from './adapter.ts';
import { AblageFehler, nimmBestandAuf, type NachzugBericht } from './nachzug.ts';
import { ladeManifest } from './leser.ts';

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
		// Stand, den WIR beim Start dieses Aufrufs kannten — die Messlatte für
		// die Konflikt-Prüfung am Ende (siehe dort).
		const standBeiStart = manifest.stand;
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
		// Vor dem Manifest-Schreiben prüfen, ob inzwischen ein anderer
		// Schreiber (zweites Gerät, zweiter Tab) seinerseits ein neueres
		// Manifest abgelegt hat. Blindes Überschreiben würfe dessen Segmente
		// aus dem Verlauf, obwohl deren Dateien physisch liegen bleiben —
		// derselbe Schaden wie bei einem Absturz zwischen Segment- und
		// Manifest-Schreiben (siehe Klassenkopf), nur ohne Absturz.
		//
		// Verglichen wird gegen `standBeiStart`, nicht gegen einen frischen
		// Lese-Vergleich unmittelbar davor: `bestandAufnehmen()` berichtigt
		// ein beschädigtes offenes Segment nur im Speicher, ohne das Manifest
		// sofort neu zu schreiben (nachzug.ts, `berichtigeOffenesSegment`) —
		// unser eigener Stand kann also legitim VOR dem Adapter liegen, ohne
		// dass jemand anders geschrieben hätte. Ein Konflikt liegt deshalb
		// nur vor, wenn der Adapter WEITER ist als das, was wir beim Start
		// kannten.
		//
		// Bei einem Konflikt wird abgebrochen statt gemergt: die Segment-
		// dateien, die dieser Aufruf gerade geschrieben hat, sind für sich
		// bereits vollständige, in sich konsistente Waisen — dieselbe
		// Konstruktion, die ein Absturz zwischen Segment- und
		// Manifest-Schreiben hinterlässt. Der Nachzug adoptiert sie beim
		// nächsten bestandAufnehmen() genauso wie nach einem Absturz; ein
		// Merge hier im Schreiber müsste dieselbe Adoptions-Logik ein
		// zweites Mal nachbauen, ohne dem Aufrufer — der wegen der
		// Id-Prüfung oben ohnehin retry-fähig sein muss — einen Vorteil zu
		// bieten, den ein Retry nicht ebenso liefert.
		const aktuell = await ladeManifest(this.adapter);
		if (aktuell !== null && aktuell.stand > standBeiStart) {
			throw new AblageFehler(
				`Ablage wurde von anderswo weitergeschrieben (Stand ${aktuell.stand} statt ${standBeiStart}) — erneut aufnehmen (bestandAufnehmen()) und wiederholen`,
			);
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
				// Nicht `letzte.rahmen` übernehmen: das ist der Manifest-Cache
				// von unserem letzten eigenen Schreiben, ein zweiter Schreiber
				// (zweites Gerät, zweiter Tab) kann die Datei zwischenzeitlich
				// verlängert haben, ohne dass wir davon wissen. Die Zahl kommt
				// deshalb aus den gerade gelesenen Bytes — und dabei genauso
				// mit einem beschädigten Ende umgehen wie leser.ts: der
				// lesbare Anfang zählt, ein kaputter Rest wird verworfen statt
				// an den neuen Happen drangehängt (sonst stünde der Müll
				// mitten in der neuen Datei, vor den frischen Rahmen).
				const { rahmen: alteRahmen } = leseRahmenFolge(alteDatei.slice(SEGMENT_KOPF_LAENGE));
				return {
					index: letzte.index,
					datei: letzte.datei,
					ersteId: letzte.ersteId,
					alteRahmen: alteRahmen.length,
					alteRahmenBytes: kodiereRahmenFolge(alteRahmen),
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
