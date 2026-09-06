/**
 * Der Leser — holt den Verlauf aus der Ablage, Segment für Segment in
 * Manifest-Ordnung. Er schreibt nie und vertraut dem Manifest nur soweit,
 * wie die Prüfsummen tragen: ein Segment mit abweichender Prüfsumme liefert
 * seinen lesbaren Anfang und eine benannte Lücke, statt den ganzen Verlauf
 * zu verwerfen.
 *
 * Der Krypto-Nachzug setzt hier auf: gelesene Megolm-Rahmen (Typ 2) öffnet
 * dann die Sitzungsschicht, die Nutzlast bleibt auch dort opak.
 */

import { type Rahmen, leseRahmenFolge } from './format.ts';
import { leseSegmentKopf, SEGMENT_KOPF_LAENGE } from './segment.ts';
import {
	MANIFEST_DATEI,
	manifestAusDaten,
	type AblageManifest,
	type SegmentEintrag,
} from './manifest.ts';
import { sha256Hex } from './pruefsumme.ts';
import type { AblageAdapter } from './adapter.ts';

export interface Verlauf {
	rahmen: Rahmen[];
	/** Segmente, die nicht vollständig lesbar waren — als `datei: Grund`. */
	luecken: string[];
}

export async function ladeManifest(adapter: AblageAdapter): Promise<AblageManifest | null> {
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

export async function leseVerlauf(adapter: AblageAdapter): Promise<Verlauf> {
	const manifest = await ladeManifest(adapter);
	const rahmen: Rahmen[] = [];
	const luecken: string[] = [];

	if (manifest === null) {
		luecken.push(`${MANIFEST_DATEI}: fehlt oder unlesbar`);
		return { rahmen, luecken };
	}

	for (const eintrag of manifest.segmente) {
		const teilstueck = await leseSegment(adapter, eintrag);
		rahmen.push(...teilstueck.rahmen);
		if (teilstueck.luecke !== null) {
			luecken.push(teilstueck.luecke);
		}
	}
	return { rahmen, luecken };
}

async function leseSegment(
	adapter: AblageAdapter,
	eintrag: SegmentEintrag,
): Promise<{ rahmen: Rahmen[]; luecke: string | null }> {
	const bytes = await adapter.lese(eintrag.datei);
	if (bytes === null) {
		return { rahmen: [], luecke: `${eintrag.datei}: fehlt` };
	}
	if ((await sha256Hex(bytes)) !== eintrag.pruefsumme) {
		// Kein Abbruch — der lesbare Anfang zählt, der Rest ist die Lücke.
		const { rahmen } = leseRahmenFolge(bytes.slice(SEGMENT_KOPF_LAENGE));
		return {
			rahmen,
			luecke: `${eintrag.datei}: Prüfsumme weicht ab, ${rahmen.length} von ${eintrag.rahmen} Rahmen lesbar`,
		};
	}
	try {
		leseSegmentKopf(bytes);
	} catch {
		return { rahmen: [], luecke: `${eintrag.datei}: Kopf unlesbar` };
	}
	const { rahmen } = leseRahmenFolge(bytes.slice(SEGMENT_KOPF_LAENGE));
	if (rahmen.length !== eintrag.rahmen) {
		return {
			rahmen,
			luecke: `${eintrag.datei}: ${rahmen.length} statt ${eintrag.rahmen} Rahmen`,
		};
	}
	return { rahmen, luecke: null };
}
