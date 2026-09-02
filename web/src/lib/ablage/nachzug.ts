/**
 * Der Nachzug — nimmt den Ablage-Bestand auf, bevor geschrieben wird:
 * Manifest laden, fehlendes oder unlesbares aus den Segmenten neu bauen,
 * verwaiste Segmentdateien adoptieren und das offene (höchste) Segment
 * gegen seine Prüfsumme berichtigen.
 *
 * Die Absturz-Reihenfolge des Schreibers (erst Segment, zuletzt Manifest)
 * erzeugt genau die zwei Schadensbilder, die hier repariert werden: eine
 * Segmentdatei, die das Manifest nicht kennt, und ein gekapptes offenes
 * Segment, dessen Prüfsumme nicht mehr stimmt.
 */

import { kodiereRahmenFolge, leseRahmenFolge } from './format.ts';
import { baueSegment, leseSegmentKopf, segDateiName, segIndexAusName, SegmentFehler, SEGMENT_KOPF_LAENGE } from './segment.ts';
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

export class AblageFehler extends Error {
	constructor(meldung: string) {
		super(meldung);
		this.name = 'AblageFehler';
	}
}
// Keine Parameter-Properties in dieser Datei — siehe Hinweis in manifest.ts.

export interface NachzugBericht {
	adoptiert: string[];
	uebersprungen: string[];
	/** true, wenn das Manifest fehlte oder unlesbar war und neu gebaut wurde. */
	neuGebaut: boolean;
}

/** Ein aus einer Datei zurückgelesener Eintrag samt bereinigter Bytes. */
interface GelesenesSegment {
	eintrag: SegmentEintrag;
	/** Nicht-null, wenn die Datei hinter dem lesbaren Anfang Müll trägt und neu geschrieben werden muss. */
	bereinigt: Uint8Array | null;
}

export async function nimmBestandAuf(
	adapter: AblageAdapter,
	kanalId: string,
): Promise<{ manifest: AblageManifest; bericht: NachzugBericht }> {
	const bericht: NachzugBericht = { adoptiert: [], uebersprungen: [], neuGebaut: false };
	const dateien = await adapter.liste();

	let manifest = await ladeManifest(adapter);
	if (manifest === null) {
		bericht.neuGebaut = true;
		manifest = erstelleManifest(kanalId);
	} else {
		manifest = await berichtigeOffenesSegment(adapter, manifest, bericht);
	}

	const waisen = verwaisteSegmente(manifest, dateien)
		.map(segIndexAusName)
		.filter((i): i is number => i !== null)
		.sort((a, b) => a - b);
	for (const index of waisen) {
		const datei = segDateiName(index);
		const gelesen = await leseSegment(adapter, datei, index);
		if (gelesen === null) {
			bericht.uebersprungen.push(datei);
			continue;
		}
		try {
			if (gelesen.bereinigt !== null) {
				await adapter.schreibe(datei, gelesen.bereinigt);
			}
			manifest = manifestMitSegment(manifest, gelesen.eintrag);
			bericht.adoptiert.push(datei);
		} catch {
			bericht.uebersprungen.push(datei);
		}
	}

	if (bericht.adoptiert.length > 0 || bericht.neuGebaut) {
		await adapter.schreibe(
			MANIFEST_DATEI,
			new TextEncoder().encode(JSON.stringify(manifest)),
		);
	}
	return { manifest, bericht };
}

async function ladeManifest(adapter: AblageAdapter): Promise<AblageManifest | null> {
	const bytes = await adapter.lese(MANIFEST_DATEI);
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
async function berichtigeOffenesSegment(
	adapter: AblageAdapter,
	manifest: AblageManifest,
	bericht: NachzugBericht,
): Promise<AblageManifest> {
	const letzte = manifest.segmente[manifest.segmente.length - 1];
	if (letzte === undefined) {
		return manifest;
	}
	const bytes = await adapter.lese(letzte.datei);
	if (bytes === null || (await sha256Hex(bytes)) === letzte.pruefsumme) {
		return manifest;
	}
	const gelesen = await leseSegment(adapter, letzte.datei, letzte.index);
	if (gelesen === null) {
		throw new AblageFehler(
			`Offenes Segment ${letzte.datei} ist unlesbar und kann nicht berichtigt werden`,
		);
	}
	if (gelesen.bereinigt !== null) {
		await adapter.schreibe(letzte.datei, gelesen.bereinigt);
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
async function leseSegment(
	adapter: AblageAdapter,
	datei: string,
	erwartetIndex: number,
): Promise<GelesenesSegment | null> {
	const bytes = await adapter.lese(datei);
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
