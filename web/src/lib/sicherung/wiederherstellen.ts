/**
 * Der Wiederherstellungs-Leser: baut aus dem Sicherungs-Container im
 * Laufwerk die Einträge wieder auf, die der Spiegel hineingeschrieben hat.
 *
 * **Die Wahrheit ist die Dateiliste, nicht das Manifest.** Das Manifest
 * jedes Geräte-Namensraums ist nur ein Cache — ein Absturz zwischen
 * Segmentdatei und Manifest, oder zwei Geräte, die sich abwechselnd
 * angreifen, hinterlassen sonst einen Bestand, den kein Leser sieht. Der
 * Rahmenkopf trägt die Segment-Nummer (`leseSegmentKopf`), die Ordnung
 * kommt allein aus den Eintrags-Nutzlasten: dort reist die
 * Nachricht-Snowflake, und gegen sie wird sortiert und dedupliziert
 * (`kanalId:nachricht.id` — dieselbe Nachricht landet über zwei Geräte
 * zweimal im Container, weil beide sie empfangen und spiegeln).
 *
 * Beschädigte Segmente sind ein Befund, kein Abbruch: sie wandern in die
 * `lücken`-Liste, der Rest des Bestands wird geliefert — dieselbe Haltung
 * wie `ablage/leser.ts` gegenüber Prüfsummen-Lücken.
 *
 * **Inkrementell:** `leseSicherungInkrementell` nimmt einen Lesestand
 * entgegen (je Geräte-Namensraum: höchster komplett importierter Segment-
 * Index + letzte Rahmen-Id) und überspringt damit komplett importierte
 * Segmentdateien ohne Download. Die Rahmen-Id ist der gerätelokale
 * Folgezähler des Spiegels — monoton je Namensraum, deshalb genügt sie als
 * Cursor. Der neue Lesestand wird nur für saubere Dateien übernommen; ein
 * Namensraum mit Lücken kommt beim nächsten Lauf komplett wieder, und die
 * Nachrichten-Seite dedupliziert über die Ids — doppelt gelesen ist
 * doppelt überlesen.
 */

import type { AblageAdapter } from '../ablage/adapter.ts';
import { leseRahmenFolge, TYP_SICHERUNG_AES } from '../ablage/format.ts';
import { leseSegmentKopf, SegmentFehler, SEGMENT_KOPF_LAENGE } from '../ablage/segment.ts';
import { entschlüsseleEintrag, öffneSchluesselDatei } from './krypto.ts';
import { leseSicherungEintrag, type SicherungEintrag } from './nutzlast.ts';
import { SCHLUESSEL_DATEI } from './spiegel.ts';

export class SicherungLesefehler extends Error {
	constructor(meldung: string) {
		super(meldung);
		this.name = 'SicherungLesefehler';
	}
}

export interface SicherungBestand {
	eintraege: SicherungEintrag[];
	/** Segmentdateien, die sich nicht lesen ließen — Anzeige, nicht Abbruch. */
	lücken: string[];
}

/** Wie weit hat ein Gerät einen Namensraum schon importiert. */
export interface SicherungLeseStand {
	/** Alle Segmente mit KLEINEREM Index sind vollständig importiert. */
	segIndex: number;
	/** Im Segment `segIndex` ist alles bis (einschließlich) dieser Rahmen-Id importiert. */
	frameId: string;
}

export type SicherungLeseStaende = Record<string, SicherungLeseStand>;

/** Erkennt eine Segmentdatei JEDES Geräte-Namensraums — der Präfix ist
 *  `geraeteKuerzel()` plus Dateiname, der Bindestrich dazwischen fehlt je
 *  nach Kürzel-Fassung (bestehende Container haben `dev-428822e8seg-…`). */
const SEGMENT_MUSTER = /^dev-[0-9a-f]{8}-?seg-(\d{6})\.puls$/;

/** Passwort-Weg: entpackt die Schlüssel-Datei und liest dann ALLES. */
export async function leseSicherung(
	adapter: AblageAdapter,
	passwort: string,
): Promise<SicherungBestand> {
	const schluesselBytes = await adapter.lese(SCHLUESSEL_DATEI);
	if (schluesselBytes === null) {
		throw new SicherungLesefehler('keine Sicherung in diesem Laufwerks-Ordner');
	}
	const { dek } = await öffneSchluesselDatei(schluesselBytes, passwort);
	return leseSicherungMitSchluessel(adapter, dek);
}

/** Volllauf mit entpacktem DEK — erster Import oder „alles noch einmal". */
export async function leseSicherungMitSchluessel(
	adapter: AblageAdapter,
	dek: Uint8Array,
): Promise<SicherungBestand> {
	return leseSicherungInkrementell(adapter, dek, {}).then((r) => r.bestand);
}

/**
 * Inkrementeller Lauf: verarbeitet nur, was hinter dem Lesestand liegt, und
 * liefert den neuen Stand zurück (nur für saubere Namensräume angehoben).
 */
export async function leseSicherungInkrementell(
	adapter: AblageAdapter,
	dek: Uint8Array,
	lesestand: SicherungLeseStaende,
): Promise<{ bestand: SicherungBestand; lesestand: SicherungLeseStaende }> {
	const namen = (await adapter.liste()).filter((name) => SEGMENT_MUSTER.test(name));
	namen.sort();

	// Je Namensraum verarbeiten — Cursor und Fortschritt gehören zum Präfix.
	const jePraefix = new Map<string, string[]>();
	for (const name of namen) {
		const praefix = name.slice(0, name.indexOf('seg-'));
		const liste = jePraefix.get(praefix) ?? [];
		liste.push(name);
		jePraefix.set(praefix, liste);
	}

	const lücken: string[] = [];
	const nachSchluessel = new Map<string, SicherungEintrag>();
	const neuerStand: SicherungLeseStaende = {};

	for (const [praefix, dateien] of jePraefix) {
		const stand = lesestand[praefix] ?? { segIndex: -1, frameId: '0' };
		let maxSegIndex = stand.segIndex;
		let maxFrameId = BigInt(stand.frameId);
		let praefixSaubere = true;

		for (const name of dateien) {
			const index = Number(SEGMENT_MUSTER.exec(name)![1]);
			if (index < stand.segIndex) continue; // komplett importiert
			const bytes = await adapter.lese(name);
			if (bytes === null) {
				lücken.push(`${name}: Datei verschwand beim Lesen`);
				praefixSaubere = false;
				continue;
			}
			try {
				leseSegmentKopf(bytes);
			} catch (fehler) {
				if (fehler instanceof SegmentFehler) {
					lücken.push(`${name}: ${fehler.grund}`);
					praefixSaubere = false;
					continue;
				}
				throw fehler;
			}
			const { rahmen, abbruch } = leseRahmenFolge(bytes.slice(SEGMENT_KOPF_LAENGE));
			if (abbruch !== null) {
				lücken.push(`${name}: Rahmen abgebrochen bei ${abbruch.bei}`);
				praefixSaubere = false;
			}
			maxSegIndex = Math.max(maxSegIndex, index);
			for (const rahmenEinzeln of rahmen) {
				if (rahmenEinzeln.eintragsId > maxFrameId) maxFrameId = rahmenEinzeln.eintragsId;
				// Bereits importierte Rahmen des offenen Segments überspringen.
				if (rahmenEinzeln.eintragsId <= BigInt(stand.frameId)) continue;
				if (rahmenEinzeln.typ !== TYP_SICHERUNG_AES) continue;
				try {
					const klar = await entschlüsseleEintrag(dek, rahmenEinzeln.nutzlast);
					const eintrag = leseSicherungEintrag(klar);
					const schluessel = `${eintrag.kanalId}:${eintrag.nachricht.id}`;
					const vorhanden = nachSchluessel.get(schluessel);
					// Dieselbe Nachricht kann aus zwei Rahmen stammen (z. B.
					// Backfill ohne Anhänge + Live-Spiegelung mit) — die
					// reichere Fassung gewinnt.
					if (
						vorhanden === undefined ||
						eintrag.nachricht.anhaenge.length > vorhanden.nachricht.anhaenge.length
					) {
						nachSchluessel.set(schluessel, eintrag);
					}
				} catch {
					lücken.push(`${name}: Eintrag unlesbar (Rahmen ${rahmenEinzeln.eintragsId})`);
					praefixSaubere = false;
				}
			}
		}

		if (praefixSaubere && dateien.length > 0) {
			neuerStand[praefix] = { segIndex: maxSegIndex, frameId: maxFrameId.toString() };
		}
	}

	const eintraege = [...nachSchluessel.values()].sort((a, b) =>
		a.nachricht.id === b.nachricht.id
			? a.kanalId.localeCompare(b.kanalId)
			: BigInt(a.nachricht.id) < BigInt(b.nachricht.id)
				? -1
				: 1,
	);
	return { bestand: { eintraege, lücken }, lesestand: neuerStand };
}
