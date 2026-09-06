/**
 * Der Wiederherstellungs-Leser des Ordner-Archivs: EIN Ordner je
 * Unterhaltung (`<kanalId>/dev-<kürzel>-seg-NNNNNN.puls`), gelesen über den
 * präfixten Adapter (`spiegel.ts::ordnerAdapter`) — der Leser hier sieht nur
 * Dateien SEINES Kanals und arbeitet mit bloßen Segment-Namen.
 *
 * **Die Wahrheit ist die Dateiliste, nicht das Manifest.** Das Manifest
 * jeder Geräte-Kette ist nur ein Cache — ein Absturz zwischen Segmentdatei
 * und Manifest, oder zwei Geräte, die sich abwechselnd angreifen, hinterlassen
 * sonst einen Bestand, den kein Leser sieht. Der Rahmenkopf trägt die
 * Segment-Nummer (`leseSegmentKopf`), die Ordnung kommt allein aus den
 * Eintrags-Nutzlasten: dort reist die Nachricht-Snowflake.
 *
 * **Seitenweise rückwärts** (`leseSicherungKanalSeite`): die Ansicht will
 * die NEUESTEN `anzahl` Nachrichten und beim Hochscrollen die davor. Der
 * Lauf geht deshalb Segmente absteigend durch, innerhalb eines Segments die
 * Rahmen absteigend (höchste Rahmen-Id zuerst).
 *
 * **Je Geräte-Kette ein eigenes Gelesen-Fenster.** Zwei Geräte zählen
 * Segment-Index und Rahmen-Id UNABHÄNGIG — ein gemeinsamer Cursor würde in
 * einem Zwei-Geräte-Ordner Rahmen der fremden Kette überspringen. Das
 * Fenster einer Kette hat zwei Grenzen, weil das Log an EINEM Ende wächst,
 * aber von ZWEI Seiten gelesen wird:
 *
 *   - `tief` — die älteste durch eine Seite erfasste Position. Alles
 *     DARUNTER ist noch ungelesen und kommt auf spätere Seiten (der
 *     nächste Aufruf liefert nur strikt Älteres).
 *   - `hoch` — die höchste gelieferte Position. Alles DARÜBER ist seitdem
 *     NEU angekommen (z. B. Offline-Nachrichten eines anderen Geräts) und
 *     kommt auf den nächsten Lauf — derselbe Nachzug, den der frühere
 *     Vorwärts-Leser mit seinem High-Water-Cursor leistete. Ein einzelner
 *     Cursor beider Art würde entweder Neuankömmlinge oder Seiten-Inhalt
 *     verlieren, weil eine Position allein beides nicht unterscheiden kann.
 *
 *  Zwischen den Grenzen ist geliefert und wird übersprungen. Der Aufrufer
 *  dedupliziert zusätzlich über `verlaufPutSaetze` (Upsert) — dieselbe
 *  Nachricht kann aus zwei Ketten kommen, weil beide Geräte sie empfangen
 *  und spiegeln.
 *
 * Beschädigte Segmente und unlesbare Nutzlasten sind ein Befund, kein
 * Abbruch: sie werden übersprungen, der Cursor wandert über sie hinweg —
 * dieselbe Haltung wie `ablage/leser.ts` gegenüber Prüfsummen-Lücken.
 */

import type { AblageAdapter } from '../ablage/adapter.ts';
import { leseRahmenFolge, TYP_SICHERUNG_AES } from '../ablage/format.ts';
import { leseSegmentKopf, SEGMENT_KOPF_LAENGE } from '../ablage/segment.ts';
import { entschlüsseleEintrag } from './krypto.ts';
import { leseSicherungEintrag, type SicherungEintrag } from './nutzlast.ts';

/** Eine Position im Rahmen-Log einer Geräte-Kette. */
export interface SicherungPosition {
	segIndex: number;
	frameId: string;
}

/** Gelesen-Fenster einer Geräte-Kette: alles ab `tief` (einschließlich)
 *  bis `hoch` (einschließlich) ist geliefert. Beide null: noch nichts
 *  gelesen. */
export interface SicherungLeseStand {
	hoch: SicherungPosition | null;
	tief: SicherungPosition | null;
}

export type SicherungLeseStaende = Record<string, SicherungLeseStand>;

/** Erkennt eine Segmentdatei JEDES Geräte-Namensraums — der Präfix ist
 *  `geraeteKuerzel()` plus Dateiname, der Bindestrich dazwischen fehlt je
 *  nach Kürzel-Fassung (bestehende Container haben `dev-428822e8seg-…`). */
const SEGMENT_MUSTER = /^dev-[0-9a-f]{8}-?seg-(\d{6})\.puls$/;

/** Erkennt einen Kanal-Ordner in der WURZEL-Listung des Archivs — der
 *  Ordner einer Unterhaltung existiert genau dann, wenn er ein Segment
 *  trägt. (Präfix-Adapter liefern die Namen OHNE `<kanalId>/`; dieses
 *  Muster dient dem Bulk-Lauf, der alle Ordner erst einmal finden muss.) */
export const KANAL_ORDNER_MUSTER = /^([^/]+)\/dev-[0-9a-f]{8}-?seg-\d{6}\.puls$/;

function segIndexVon(name: string): number {
	return Number(SEGMENT_MUSTER.exec(name)![1]);
}

/** Positionen innerhalb EINER Kette vergleichen (höher = neuer). */
function positionVergleich(a: SicherungPosition, b: SicherungPosition): number {
	if (a.segIndex !== b.segIndex) return a.segIndex - b.segIndex;
	const fa = BigInt(a.frameId);
	const fb = BigInt(b.frameId);
	return fa < fb ? -1 : fa > fb ? 1 : 0;
}

/**
 * Eine Seite aus dem Kanal-Ordner: bis zu `anzahl` Nachrichten, gelesen von
 * neu nach alt — Neuangekommenes oberhalb des Fensters zuerst, dann der
 * Seiten-Inhalt unterhalb von `tief`. Der zurückgegebene Lesestand schließt
 * das Fenster um alles so Erreichte. `anzahl = Infinity` liest den Ordner
 * vollständig in einem Lauf (Bulk-Weg).
 *
 * `erschoepft` (B10) sagt, ob der Lauf die `anzahl`-Grenze NIE erreicht
 * hat — also jede Kette bis zu ihrem Datei-Ende durch ist und der nächste
 * Lauf nur durch NEU dazwischengekommene Segmente etwas finden könnte.
 * Der Bulk-Aufrufer braucht danach keinen Bestätigungs-Lauf mehr, der den
 * Ordner nur erneut aus dem Drive läde.
 */
export async function leseSicherungKanalSeite(
	adapter: AblageAdapter,
	dek: Uint8Array,
	lesestand: SicherungLeseStaende,
	anzahl: number,
): Promise<{
	eintraege: SicherungEintrag[];
	lesestand: SicherungLeseStaende;
	erschoepft: boolean;
}> {
	// B10: `true`, sobald ein Lauf an der `anzahl`-Grenze abbricht — dann
	// sind Ketten/Segmente unbehandelt geblieben und der Ordner ist NICHT
	// erschöpft. Bei `anzahl = Infinity` trifft die Grenze nie zu.
	let voll = false;
	// Je Geräte-Kette gruppieren — Cursor und Fortschritt gehören zum Präfix.
	const jePraefix = new Map<string, string[]>();
	for (const name of await adapter.liste()) {
		if (!SEGMENT_MUSTER.test(name)) continue;
		const praefix = name.slice(0, name.indexOf('seg-'));
		const liste = jePraefix.get(praefix) ?? [];
		liste.push(name);
		jePraefix.set(praefix, liste);
	}

	// Kette mit dem neuesten Segment zuerst — die Seite soll vor allem
	// frische Nachrichten tragen.
	const ketten = [...jePraefix.entries()].sort(
		(a, b) => Math.max(...b[1].map(segIndexVon)) - Math.max(...a[1].map(segIndexVon)),
	);

	const nachSchluessel = new Map<string, SicherungEintrag>();
	const neuerStand: SicherungLeseStaende = { ...lesestand };

	for (const [praefix, dateien] of ketten) {
		if (nachSchluessel.size >= anzahl) {
			voll = true;
			break;
		}
		// NEUESTE Segmente zuerst (Index absteigend).
		dateien.sort((a, b) => segIndexVon(b) - segIndexVon(a));
		const stand = lesestand[praefix] ?? { hoch: null, tief: null };
		// Höchste und tiefste in DIESEM Lauf gelieferte Position — sie
		// schließen das Fenster der Kette, sobald der Lauf endet (Seite
		// voll oder Kette am Ende). Der Cursor wandert über JEDEN
		// gelieferten Rahmen, auch über fremde Typen und unlesbare
		// Nutzlasten: sonst fände der nächste Lauf genau diese Rahmen
		// immer wieder neu.
		let erste: SicherungPosition | null = null;
		let letzte: SicherungPosition | null = null;

		for (const name of dateien) {
			if (nachSchluessel.size >= anzahl) {
				voll = true;
				break;
			}
			const index = segIndexVon(name);
			const bytes = await adapter.lese(name);
			if (bytes === null) continue; // Datei verschwand beim Lesen
			try {
				leseSegmentKopf(bytes);
			} catch {
				continue; // Kopf beschädigt — Datei überspringen, Rest zählt
			}
			const { rahmen } = leseRahmenFolge(bytes.slice(SEGMENT_KOPF_LAENGE));
			// Innerhalb des Segments absteigend: die neuesten Rahmen zuerst.
			rahmen.sort((a, b) =>
				a.eintragsId > b.eintragsId ? -1 : a.eintragsId < b.eintragsId ? 1 : 0,
			);
			for (const rahmenEinzeln of rahmen) {
				const position: SicherungPosition = {
					segIndex: index,
					frameId: rahmenEinzeln.eintragsId.toString(),
				};
				const überHoch =
					stand.hoch !== null && positionVergleich(position, stand.hoch) > 0;
				// Im Gelesen-Fenster (und nicht darüber hinaus neu angekommen)
				// ist der Rahmen bereits auf einer Seite geliefert.
				const imFenster =
					!überHoch &&
					stand.tief !== null &&
					positionVergleich(position, stand.tief) >= 0;
				if (imFenster) continue;
				if (erste === null) erste = position;
				letzte = position;
				if (rahmenEinzeln.typ !== TYP_SICHERUNG_AES) continue;
				try {
					const klar = await entschlüsseleEintrag(dek, rahmenEinzeln.nutzlast);
					const eintrag = leseSicherungEintrag(klar);
					const schluessel = `${eintrag.kanalId}:${eintrag.nachricht.id}`;
					const vorhanden = nachSchluessel.get(schluessel);
					// Dieselbe Nachricht kann aus zwei Ketten stammen (zwei
					// Geräte spiegeln beide) — sonst gewinnt die reichere
					// Fassung (mehr Anhänge). ÜBER den Grabstein entscheidet
					// das nicht: einmal gelöscht bleibt gelöscht, auch wenn
					// die Nachrichten-Fassung die reichere ist — sonst würde
					// die Seite die gelöschte Nachricht wiederherstellen.
					const steinAlt = vorhanden?.nachricht.geloescht === true;
					const steinNeu = eintrag.nachricht.geloescht === true;
					if (
						vorhanden === undefined ||
						(steinNeu && !steinAlt) ||
						(!steinNeu &&
							!steinAlt &&
							eintrag.nachricht.anhaenge.length > vorhanden.nachricht.anhaenge.length)
					) {
						nachSchluessel.set(schluessel, eintrag);
					}
				} catch {
					/* Unlesbare Nutzlast — überspringen, der Cursor ist drüber */
				}
				if (nachSchluessel.size >= anzahl) {
					voll = true;
					break;
				}
			}
		}
		// Fenster nur dort schließen, wo dieser Lauf tatsächlich war — eine
		// nicht besuchte Kette bleibt ganz stehen und kommt beim nächsten
		// Lauf komplett.
		if (letzte !== null && erste !== null) {
			neuerStand[praefix] = {
				hoch:
					stand.hoch !== null && positionVergleich(stand.hoch, erste) > 0
						? stand.hoch
						: erste,
				tief:
					stand.tief !== null && positionVergleich(letzte, stand.tief) > 0
						? stand.tief
						: letzte,
			};
		}
	}

	// Neueste zuerst (Nachricht-Snowflake) — dieselbe Ordnung, die die
	// Ansicht nach dem Merge erwartet.
	const eintraege = [...nachSchluessel.values()].sort((a, b) =>
		a.nachricht.id === b.nachricht.id
			? a.kanalId.localeCompare(b.kanalId)
			: BigInt(a.nachricht.id) > BigInt(b.nachricht.id)
				? -1
				: 1,
	);
	return { eintraege, lesestand: neuerStand, erschoepft: !voll };
}
