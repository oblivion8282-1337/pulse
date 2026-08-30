/**
 * Ein Segment ist eine Datei voller Rahmen (siehe format.ts) mit einem
 * kleinen Kopf davor, der die Segment-Nummer trägt. Der Kopf macht jede
 * Segmentdatei für sich beschreibend — geht das Manifest verloren, lässt
 * sich die Ordnung allein aus den Dateien zurücklesen.
 *
 *   "PSEG" (4) | Fassung (1) | Segment-Index (4, big endian) | Rahmen …
 *
 * Import-frei bis auf format.ts (mit Endung, Node-Testläufer-regel).
 */

import { type Rahmen, kodiereRahmen, leseRahmenFolge } from './format.ts';

export const SEGMENT_KENNUNG = 0x50534547; // "PSEG"
export const SEGMENT_FASSUNG = 1;
export const SEGMENT_KOPF_LAENGE = 9;

export class SegmentFehler extends Error {
	readonly grund: 'abgeschnitten' | 'unbekannteKennung' | 'unbekannteFassung';

	constructor(grund: 'abgeschnitten' | 'unbekannteKennung' | 'unbekannteFassung') {
		super(`Segmentkopf unlesbar: ${grund}`);
		this.name = 'SegmentFehler';
		this.grund = grund;
	}
}

/** Baut die vollständigen Segment-Bytes aus Kopf und bereits kodierten Rahmen. */
export function baueSegment(index: number, rahmenBytes: Uint8Array): Uint8Array {
	const segment = new Uint8Array(SEGMENT_KOPF_LAENGE + rahmenBytes.length);
	const sicht = new DataView(segment.buffer);
	sicht.setUint32(0, SEGMENT_KENNUNG);
	sicht.setUint8(4, SEGMENT_FASSUNG);
	sicht.setUint32(5, index);
	segment.set(rahmenBytes, SEGMENT_KOPF_LAENGE);
	return segment;
}

export function baueSegmentAusRahmen(index: number, rahmen: Rahmen[]): Uint8Array {
	const teile = rahmen.map((r) => kodiereRahmen(r.eintragsId, r.nutzlast, r.typ));
	const laenge = teile.reduce((summe, t) => summe + t.length, 0);
	const rahmenBytes = new Uint8Array(laenge);
	let bei = 0;
	for (const teil of teile) {
		rahmenBytes.set(teil, bei);
		bei += teil.length;
	}
	return baueSegment(index, rahmenBytes);
}

export function leseSegmentKopf(bytes: Uint8Array): { fassung: number; index: number } {
	if (bytes.length < SEGMENT_KOPF_LAENGE) {
		throw new SegmentFehler('abgeschnitten');
	}
	const sicht = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (sicht.getUint32(0) !== SEGMENT_KENNUNG) {
		throw new SegmentFehler('unbekannteKennung');
	}
	const fassung = sicht.getUint8(4);
	if (fassung !== SEGMENT_FASSUNG) {
		throw new SegmentFehler('unbekannteFassung');
	}
	return { fassung, index: sicht.getUint32(5) };
}

/** Segment-Namen mit führenden Nullen, damit die lexikalische Ordnung stimmt. */
export function segDateiName(index: number): string {
	return `seg-${String(index).padStart(6, '0')}.puls`;
}

/** Liefert die Index-Nummer eines Segment-Dateinamens, sonst null. */
export function segIndexAusName(name: string): number | null {
	const treffer = /^seg-(\d{6})\.puls$/.exec(name);
	return treffer ? Number(treffer[1]) : null;
}
