/**
 * Der Klartext-Kern einer Archiv-Zeile (Gruppen-Erweiterung 2026-10-05).
 *
 * Ein einziges JSON — kompakte Ein-Buchstaben-Felder, die Nutzlast-Grenze
 * je Zeile bleibt klein (32 768 Base64-Zeichen):
 *
 *   i  Nachrichten-Id          t  Text
 *   a  Absender-Konto-Id       z  Sende-Zeitpunkt (ISO)
 *   r  Antwort-auf-Id?         anh  Anhang-Angaben?
 *
 * **Anhänge reisen als ANGABEN mit, die Bytes nicht** (Entscheidung
 * 03.10.: Durchlauferhitzer bleibt) — ein anderes Gerät rendert daraus die
 * Platzhalter-Kachel und holt die Bytes lokal, aus der privaten
 * Cloud-Sicherung oder gar nicht (`krypto/anhangHolen.ts`).
 *
 * Vor der Gruppen-Erweiterung trug die Zeile statt `anh` nur die Anzahl
 * (`v`) — `leseZeilenKlar` toleriert beide Fassungen, es gibt dort nichts
 * anzuzeigen.
 *
 * Import-frei bis auf Typen (Node-Testläufer-Regel, s. `verlauf/schema.ts`).
 */
import type { Message } from '../api/types';
import type { AnhangAngabe } from '../krypto/nachrichtNutzlast';
// .ts-Endung: dieses Modul läuft im Node-Testläufer (Konvention s.
// `verlauf/schema.ts`) — der Bundler akzeptiert die Endung unverändert.
import { attachmentZuAngabe, anhangAngabeZuAttachment } from '../krypto/anhangAnzeige.ts';

export type ArchivZeileKlar = {
	i: string;
	t: string;
	a: string;
	z: string;
	r?: string;
	anh?: AnhangAngabe[];
};

/** Eine gesendete Nachricht → Klartext-Bytes für die Archiv-Zeile. */
export function baueZeilenKlar(nachricht: Message): Uint8Array {
	const klar: ArchivZeileKlar = {
		i: nachricht.id,
		t: nachricht.content,
		a: nachricht.author_id,
		z: nachricht.created_at,
		...(nachricht.reply_to_id ? { r: nachricht.reply_to_id } : {}),
		...(nachricht.attachments?.length
			? { anh: nachricht.attachments.map(attachmentZuAngabe) }
			: {})
	};
	return new TextEncoder().encode(JSON.stringify(klar));
}

/** Archiv-Zeilen-Klartext → Nachricht für den lokalen Verlauf. Die Kanal-Id
 *  kommt aus der Zeilen-Position beim Server, nicht aus der Nutzlast. */
export function leseZeilenKlar(kanalId: string, roh: string): Message {
	const inhalt = JSON.parse(roh) as ArchivZeileKlar;
	return {
		id: inhalt.i,
		channel_id: kanalId,
		author_id: inhalt.a,
		content: inhalt.t,
		nonce: null,
		reply_to_id: inhalt.r ?? null,
		created_at: inhalt.z,
		verschluesselt: true,
		...(inhalt.anh?.length
			? { attachments: inhalt.anh.map(anhangAngabeZuAttachment) }
			: {})
	};
}
