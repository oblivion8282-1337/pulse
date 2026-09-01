/**
 * Speichert/liest den Ablage-Hauptschluessel + die Freigabe-Adresse EINES
 * Ablage-Kanals auf diesem Geraet (Design §3.1). Zwei Herkuenfte fuellen
 * denselben Eintrag:
 *
 * 1. Das Geraet, das den Kanalordner verbindet, erzeugt beide Werte lokal
 *    und sichert sie hier, BEVOR/NACHDEM es die Freigabe-Adresse per
 *    `PUT /channels/{id}/ablage/laufwerk` meldet (Verdrahtung ausserhalb
 *    dieser Datei).
 * 2. Ein Mitgliedsgeraet bekommt beides ueber das Postfach zugestellt
 *    (`krypto/gruppe/empfangen.ts::verteilschluesselAufnehmen`) und sichert
 *    sie hier beim Empfang.
 *
 * Beide Seiten lesen anschliessend denselben Eintrag — u. a. der Leseweg
 * (`kanalLeseweg.ts`) und, fuer die Weiterverteilung an noch offene
 * Geraete, `krypto/gruppe/kanalSenden.ts`.
 *
 * **Liegt in der Identitaets-IndexedDB** (`identity/idb-shared.ts`), aber
 * OHNE den Pickle-Umweg der Olm-/Megolm-Sitzungen: anders als eine
 * Sitzung ist das hier kein rotierendes Ratchet-Geheimnis, sondern ein
 * einmal verteilter, langlebiger Schluessel — dieselbe Einordnung wie beim
 * Sync-Ordner-Hauptschluessel (`syncOrdnerSchluessel.ts`).
 *
 * **Fail-closed:** `laden` gibt `null` zurueck, wenn nichts (oder etwas
 * Kaputtes) hinterlegt ist. Der Aufrufer laesst den Kanal dann ungeoeffnet,
 * genau wie bei einer fehlenden Gruppensitzung — nichts wird geraten.
 */

import { openIdentityDb, idbGetIdentity, idbPutIdentity } from '../identity/idb-shared';

export interface KanalLaufwerkSchluessel {
	/** Base64. */
	hauptschluessel: string;
	freigabeAdresse: string;
}

function schluesselKey(kanalId: string): string {
	return `pulse.ablage-kanal-laufwerk.${kanalId}`;
}

export async function kanalLaufwerkSchluesselSichern(
	kanalId: string,
	hauptschluessel: string,
	freigabeAdresse: string
): Promise<void> {
	const db = await openIdentityDb();
	await idbPutIdentity(db, schluesselKey(kanalId), { hauptschluessel, freigabeAdresse });
	db.close();
}

export async function kanalLaufwerkSchluesselLaden(
	kanalId: string
): Promise<KanalLaufwerkSchluessel | null> {
	const db = await openIdentityDb();
	const roh = await idbGetIdentity(db, schluesselKey(kanalId));
	db.close();
	if (roh === undefined || roh === null || typeof roh !== 'object') return null;
	const o = roh as Record<string, unknown>;
	if (typeof o.hauptschluessel !== 'string' || typeof o.freigabeAdresse !== 'string') return null;
	return { hauptschluessel: o.hauptschluessel, freigabeAdresse: o.freigabeAdresse };
}
