/**
 * Das Manifest ist der Index des Ablage-Logs: welche Segmente gibt es, wie
 * groß sind sie, welcher Prüfsumme gehorchen sie, welche Id-Spanne tragen
 * sie. In Phase 1 liegt es als Klartext-JSON im Ablage-Ordner; der
 * Krypto-Nachzug verschlüsselt es in einem Zug (gleicher Ort, gleiche Rolle).
 *
 * Zwei Regeln machen es gegenüber Abstürzen entspannt:
 *
 * 1. Das Manifest wird **zuletzt** geschrieben — ein Absturz vorher hinterlässt
 *    eine verwaiste Segmentdatei, die beim nächsten Start adoptiert wird.
 * 2. Es ist **abgeleitet** — aus Kopf und Rahmen der Segmente neu baubar
 *    (Archiv-Muster: das Manifest ist ein Index, kein Alleinbesitzer der Wahrheit).
 *
 * Rein rechnerisch und import-frei.
 */

export const MANIFEST_DATEI = 'manifest.puls';
export const MANIFEST_FASSUNG = 1;

export interface SegmentEintrag {
	index: number;
	datei: string;
	rahmen: number;
	bytes: number;
	/** SHA-256 der Segmentdatei, hexadezimal. */
	pruefsumme: string;
	/** Snowflake des ersten/letzten Rahmens — als Dezimalstring, u64 übersteigt JSON-Zahlen. */
	ersteId: string;
	letzteId: string;
}

export interface AblageManifest {
	fassung: number;
	kanalId: string;
	/** Zählt mit jedem Manifest-Schreiben hoch; macht veraltete Kopien erkennbar. */
	stand: number;
	segmente: SegmentEintrag[];
	letzteId: string | null;
}

export class ManifestFehler extends Error {
	constructor(meldung: string) {
		super(meldung);
		this.name = 'ManifestFehler';
	}
}
// Hinweis: keine Parameter-Properties (`constructor(public …)`) — der
// Node-Testläufer liest diese Dateien im Strip-only-Modus und kennt die
// nicht. Gilt für alle Klassen unter src/lib/ablage/.

export function erstelleManifest(kanalId: string): AblageManifest {
	return { fassung: MANIFEST_FASSUNG, kanalId, stand: 0, segmente: [], letzteId: null };
}

/** Strenger Parse für das Laden: jede Abweichung ist ein Befund, kein Stillhalten. */
export function manifestAusDaten(daten: unknown): AblageManifest {
	if (typeof daten !== 'object' || daten === null) {
		throw new ManifestFehler('Manifest ist kein Objekt');
	}
	const d = daten as Record<string, unknown>;
	if (d.fassung !== MANIFEST_FASSUNG) {
		throw new ManifestFehler(`Unbekannte Manifest-Fassung: ${String(d.fassung)}`);
	}
	if (typeof d.kanalId !== 'string' || typeof d.stand !== 'number') {
		throw new ManifestFehler('kanalId/stand fehlen oder haben den falschen Typ');
	}
	if (!Array.isArray(d.segmente)) {
		throw new ManifestFehler('segmente ist keine Liste');
	}
	let vorige: SegmentEintrag | null = null;
	const segmente = d.segmente.map((roh) => {
		const e = pruefeEintrag(roh);
		if (vorige !== null) {
			if (e.index !== vorige.index + 1) {
				throw new ManifestFehler(`Segment-Lücke: ${vorige.index} → ${e.index}`);
			}
			if (BigInt(e.ersteId) <= BigInt(vorige.letzteId)) {
				throw new ManifestFehler(`Id-Reihenfolge bricht zwischen Segment ${vorige.index} und ${e.index}`);
			}
		}
		vorige = e;
		return e;
	});
	const letzteId = d.letzteId === null ? null : String(d.letzteId);
	const erwartet = segmente.length > 0 ? segmente[segmente.length - 1].letzteId : null;
	if (letzteId !== erwartet) {
		throw new ManifestFehler('letzteId stimmt nicht mit dem letzten Segment überein');
	}
	return {
		fassung: MANIFEST_FASSUNG,
		kanalId: d.kanalId,
		stand: d.stand,
		segmente,
		letzteId,
	};
}

function pruefeEintrag(roh: unknown): SegmentEintrag {
	if (typeof roh !== 'object' || roh === null) {
		throw new ManifestFehler('Segment-Eintrag ist kein Objekt');
	}
	const r = roh as Record<string, unknown>;
	const zahlAus = (name: string): number => {
		const wert = r[name];
		if (typeof wert !== 'number' || !Number.isInteger(wert) || wert < 0) {
			throw new ManifestFehler(`${name} ist keine nichtnegative Zahl`);
		}
		return wert;
	};
	const zeichenAus = (name: string): string => {
		const wert = r[name];
		if (typeof wert !== 'string') {
			throw new ManifestFehler(`${name} ist kein String`);
		}
		return wert;
	};
	const eintrag: SegmentEintrag = {
		index: zahlAus('index'),
		datei: zeichenAus('datei'),
		rahmen: zahlAus('rahmen'),
		bytes: zahlAus('bytes'),
		pruefsumme: zeichenAus('pruefsumme'),
		ersteId: zeichenAus('ersteId'),
		letzteId: zeichenAus('letzteId'),
	};
	if (BigInt(eintrag.ersteId) > BigInt(eintrag.letzteId)) {
		throw new ManifestFehler(`Segment ${eintrag.index}: ersteId liegt hinter letzteId`);
	}
	return eintrag;
}

/**
 * Hängt ein Segment ans Manifest oder ersetzt das offene (letzte) Segment,
 * das um einen Batch gewachsen ist. Nur das letzte Segment darf sich
 * ändern — abgeschlossene Segmente sind unveränderlich, das ist die Grundlage
 * für Prüfsummen-Vertrauen.
 */
export function manifestMitSegment(
	manifest: AblageManifest,
	eintrag: SegmentEintrag,
): AblageManifest {
	const letzte = manifest.segmente[manifest.segmente.length - 1];
	if (letzte === undefined) {
		if (eintrag.index !== 0) {
			throw new ManifestFehler(`Erstes Segment muss Index 0 tragen, bekommen: ${eintrag.index}`);
		}
	} else if (eintrag.index === letzte.index) {
		if (BigInt(eintrag.ersteId) > BigInt(letzte.ersteId)) {
			// Wachstum am offenen Ende: erster Rahmen bleibt derselbe.
			throw new ManifestFehler(`Offenes Segment ${eintrag.index} hat einen neuen ersten Rahmen`);
		}
	} else if (eintrag.index !== letzte.index + 1) {
		throw new ManifestFehler(`Segment-Sprung: ${letzte.index} → ${eintrag.index}`);
	}
	if (letzte !== undefined && eintrag.index > letzte.index) {
		if (BigInt(eintrag.ersteId) <= BigInt(letzte.letzteId)) {
			throw new ManifestFehler(`Segment ${eintrag.index} beginnt vor dem Ende von ${letzte.index}`);
		}
	}
	return {
		...manifest,
		stand: manifest.stand + 1,
		segmente: eintrag.index === letzte?.index
			? [...manifest.segmente.slice(0, -1), eintrag]
			: [...manifest.segmente, eintrag],
		letzteId: eintrag.letzteId,
	};
}

/** Segmentdateien im Ordner, die das Manifest nicht kennt — Nachzug-Kandidaten. */
export function verwaisteSegmente(manifest: AblageManifest, dateinamen: string[]): string[] {
	const bekannt = new Set(manifest.segmente.map((s) => s.datei));
	return dateinamen.filter((name) => /^seg-\d{6}\.puls$/.test(name) && !bekannt.has(name));
}
