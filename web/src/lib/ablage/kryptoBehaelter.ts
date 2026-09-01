/**
 * Verschlüsselt die Behälter eines Ablage-Kanals — der fehlende Teil aus dem
 * Befund vom 2026-09-01: `schreiber.ts`/`segment.ts`/`leser.ts`/`nachzieher.ts`
 * legen Segment- und Manifestdateien bisher als Klartext-JSON auf dem
 * Cloud-Laufwerk ab, obwohl die Dateiablage (`dateiablage.ts`) ihre Container
 * längst mit dem Ablage-Hauptschlüssel verschlüsselt.
 *
 * **Der Weg: ein umschliessender `AblageAdapter`**, kein neues Format in
 * `segment.ts`/`manifest.ts`. Dasselbe Muster wie `spiegel.ts` (mehrere Ziele
 * zu einem) und `direktMitRueckfall.ts` (direkter Weg + Umweg zu einem):
 * `schreibe()` verschlüsselt, bevor es an den eingeschlossenen Adapter geht,
 * `lese()` entschlüsselt, was von dort zurückkommt. Schreiber und Leser
 * bleiben dadurch, was ihre Modulköpfe versprechen — sie kennen weiterhin
 * weder REST noch Krypto, ihre Prüfsummen (`manifest.ts::manifestMitSegment`)
 * rechnen unverändert über die Klartext-Bytes, weil genau die dem Schreiber/
 * Leser weiterhin vorliegen. Ein drittes Container-Format hätte das alles
 * verdoppelt, ohne dass Schreiber oder Leser davon einen Vorteil hätten.
 *
 * **Format je Behälter** (an `dateiablage.ts` angelehnt, aber eigene
 * Kennung — dies ist kein Datei-Container mit Kopf/Inhalt-Trennung, sondern
 * schlicht "die Bytes, die der Adapter sonst im Klartext bekäme"):
 *
 *   "PBHL" (4) | Fassung (1) | IV (12) | AES-256-GCM-Geheimtext
 *
 * Der Verschlüsselungsschlüssel ist NICHT der Ablage-Hauptschlüssel selbst,
 * sondern `SHA-256(Hauptschlüssel || "ablage-behaelter")` — derselbe Kniff
 * wie in `dateiablage.ts` (dort mit dem Kontext `"ablage-kopf"`): ein
 * eigener Kontext hält die Ableitung getrennt von allem, was der
 * Hauptschlüssel sonst noch verschlüsselt (Dateien, Verzeichnis), auch wenn
 * heute nichts davon kollidiert.
 *
 * **Zusatzdaten binden den Geheimtext an den Dateinamen** (`additionalData`
 * = UTF-8 des Dateinamens). Ohne das könnte ein Server, der die Rohdateien
 * verwaltet (Nextcloud-Freigabe, s. Befund), zwei gleich grosse Behälter
 * vertauschen — GCM prüft dann nur noch, dass IRGENDEIN gültiger Behälter
 * mit demselben Schlüssel vorliegt, nicht, dass es der richtige Name ist.
 * Mit der Bindung schlägt eine solche Vertauschung als Entschlüsselungsfehler
 * fehl statt als lautlos falscher Inhalt unter richtigem Namen.
 *
 * **Was ein Fremder mit dem Freigabe-Link trotzdem sieht** (ehrlich benannt,
 * s. Auftrag): die Dateinamen (`seg-000001.puls`, `manifest.puls`) und ihre
 * Grössen — beides reicht dem Server/Link-Inhaber zur groben Schätzung
 * ("wie viele Segmente, wie aktiv der Kanal"), aber nicht zum Lesen des
 * Inhalts. Es gibt keine Polsterung gegen Grössen-Rückschlüsse — dieselbe
 * Abwägung wie bei `dateiablage.ts`.
 *
 * **Bestand:** Ein vorhandener Klartext-Behälter (altes Format, ohne "PBHL"-
 * Kennung) wird NICHT automatisch umgeschlüsselt oder gar mitgelesen — das
 * wäre lautloses Weiterreichen von Klartext unter der Flagge "verschlüsselt".
 * `lese()` wirft stattdessen `BehaelterFehler('unbekannteKennung')`, genauso
 * sichtbar wie ein falscher Schlüssel. Vertretbar, weil die Ablage bislang
 * ausschliesslich auf Testgeräten lief (kein echter Bestand, der dadurch
 * verloren ginge) — ausgesprochene Entscheidung, kein Versehen.
 *
 * **Ein falscher Schlüssel liefert nie Müll.** GCM prüft die Authentizität
 * vor der Freigabe der Klartext-Bytes — ein falscher Schlüssel oder ein
 * manipuliertes Byte werfen `BehaelterFehler('entschluesselungFehlgeschlagen')`,
 * nichts wird "irgendwie" zurückgegeben.
 */

import type { AblageAdapter } from './adapter.ts';

export const BEHAELTER_KENNUNG = 0x5042484c; // "PBHL"
export const BEHAELTER_FASSUNG = 1;
const IV_LAENGE = 12;
const KOPF_LAENGE = 4 + 1 + IV_LAENGE;

export type BehaelterFehlerGrund =
	| 'zuKurz'
	| 'unbekannteKennung'
	| 'unbekannteFassung'
	| 'entschluesselungFehlgeschlagen';

export class BehaelterFehler extends Error {
	readonly grund: BehaelterFehlerGrund;
	readonly datei: string;

	constructor(grund: BehaelterFehlerGrund, datei: string) {
		super(`Behälter „${datei}" unlesbar: ${grund}`);
		this.name = 'BehaelterFehler';
		this.grund = grund;
		this.datei = datei;
	}
}

/** Eigenständige Kopie — WebCrypto braucht echte ArrayBuffer, keine Views. */
function eigen(bytes: Uint8Array): ArrayBuffer {
	return bytes.slice().buffer as ArrayBuffer;
}

async function schluesselAbleiten(hauptschluessel: Uint8Array): Promise<Uint8Array> {
	const kontext = new TextEncoder().encode('ablage-behaelter');
	const eingabe = new Uint8Array(hauptschluessel.length + kontext.length);
	eingabe.set(hauptschluessel, 0);
	eingabe.set(kontext, hauptschluessel.length);
	return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', eigen(eingabe)));
}

async function gcmSchluessel(rohSchluessel: Uint8Array, verwendung: 'encrypt' | 'decrypt') {
	return globalThis.crypto.subtle.importKey(
		'raw',
		eigen(rohSchluessel),
		{ name: 'AES-GCM' },
		false,
		[verwendung]
	);
}

/**
 * Baut den umschliessenden Adapter. `hauptschluessel` ist der rohe
 * Ablage-Hauptschlüssel (32 Bytes) — derselbe, den `dateiablage.ts` für die
 * Dateien dieser Ablage benutzt.
 */
export function verschluesselnderAdapter(
	adapter: AblageAdapter,
	hauptschluessel: Uint8Array
): AblageAdapter {
	return {
		liste: () => adapter.liste(),
		lösche: adapter.lösche ? (datei) => adapter.lösche!(datei) : undefined,

		async schreibe(datei, inhalt) {
			const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LAENGE));
			const schluessel = await gcmSchluessel(await schluesselAbleiten(hauptschluessel), 'encrypt');
			const geheimtext = new Uint8Array(
				await globalThis.crypto.subtle.encrypt(
					{ name: 'AES-GCM', iv: eigen(iv), additionalData: eigen(new TextEncoder().encode(datei)) },
					schluessel,
					eigen(inhalt)
				)
			);
			const behaelter = new Uint8Array(KOPF_LAENGE + geheimtext.length);
			const sicht = new DataView(behaelter.buffer);
			sicht.setUint32(0, BEHAELTER_KENNUNG);
			sicht.setUint8(4, BEHAELTER_FASSUNG);
			behaelter.set(iv, 5);
			behaelter.set(geheimtext, KOPF_LAENGE);
			await adapter.schreibe(datei, behaelter);
		},

		async lese(datei) {
			const behaelter = await adapter.lese(datei);
			if (behaelter === null) return null;
			if (behaelter.length < KOPF_LAENGE) throw new BehaelterFehler('zuKurz', datei);
			const sicht = new DataView(behaelter.buffer, behaelter.byteOffset, behaelter.byteLength);
			if (sicht.getUint32(0) !== BEHAELTER_KENNUNG) {
				throw new BehaelterFehler('unbekannteKennung', datei);
			}
			if (sicht.getUint8(4) !== BEHAELTER_FASSUNG) {
				throw new BehaelterFehler('unbekannteFassung', datei);
			}
			const iv = behaelter.slice(5, KOPF_LAENGE);
			const geheimtext = behaelter.slice(KOPF_LAENGE);
			const schluessel = await gcmSchluessel(await schluesselAbleiten(hauptschluessel), 'decrypt');
			try {
				return new Uint8Array(
					await globalThis.crypto.subtle.decrypt(
						{ name: 'AES-GCM', iv: eigen(iv), additionalData: eigen(new TextEncoder().encode(datei)) },
						schluessel,
						eigen(geheimtext)
					)
				);
			} catch {
				throw new BehaelterFehler('entschluesselungFehlgeschlagen', datei);
			}
		}
	};
}
