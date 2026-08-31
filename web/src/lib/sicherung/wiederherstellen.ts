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
 * Rein rechnerisch (Adapter-Injektion) — Node-Testläufer-regel.
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

/** Erkennt eine Segmentdatei JEDES Geräte-Namensraums (`dev-1a2b3c4d-seg-000007.puls`). */
const SEGMENT_MUSTER = /^dev-[0-9a-f]{8}-seg-\d{6}\.puls$/;

export async function leseSicherung(
	adapter: AblageAdapter,
	passwort: string,
): Promise<SicherungBestand> {
	const schluesselBytes = await adapter.lese(SCHLUESSEL_DATEI);
	if (schluesselBytes === null) {
		throw new SicherungLesefehler('keine Sicherung in diesem Laufwerks-Ordner');
	}
	const { dek } = await öffneSchluesselDatei(schluesselBytes, passwort);

	const namen = (await adapter.liste()).filter((name) => SEGMENT_MUSTER.test(name));
	namen.sort();
	const lücken: string[] = [];
	const nachSchluessel = new Map<string, SicherungEintrag>();

	for (const name of namen) {
		const bytes = await adapter.lese(name);
		if (bytes === null) {
			lücken.push(`${name}: Datei verschwand beim Lesen`);
			continue;
		}
		try {
			leseSegmentKopf(bytes);
		} catch (fehler) {
			if (fehler instanceof SegmentFehler) {
				lücken.push(`${name}: ${fehler.grund}`);
				continue;
			}
			throw fehler;
		}
		const { rahmen } = leseRahmenFolge(bytes.slice(SEGMENT_KOPF_LAENGE));
		for (const rahmenEinzeln of rahmen) {
			if (rahmenEinzeln.typ !== TYP_SICHERUNG_AES) continue;
			try {
				const klar = await entschlüsseleEintrag(dek, rahmenEinzeln.nutzlast);
				const eintrag = leseSicherungEintrag(klar);
				const schluessel = `${eintrag.kanalId}:${eintrag.nachricht.id}`;
				if (!nachSchluessel.has(schluessel)) {
					nachSchluessel.set(schluessel, eintrag);
				}
			} catch {
				lücken.push(`${name}: Eintrag unlesbar (Rahmen ${rahmenEinzeln.eintragsId})`);
			}
		}
	}

	const eintraege = [...nachSchluessel.values()].sort((a, b) =>
		a.nachricht.id === b.nachricht.id
			? a.kanalId.localeCompare(b.kanalId)
			: BigInt(a.nachricht.id) < BigInt(b.nachricht.id)
				? -1
				: 1,
	);
	return { eintraege, lücken };
}
