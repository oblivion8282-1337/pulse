/**
 * Der Kanal-Schlüssel je DM (Übergabe 2026-10-04, §5): 32 Zufallsbytes,
 * verschlüsselt beim Server als Wrap an den Archiv-Public-Key je Teilnehmer.
 *
 * Wettlauf zweier Geräte (beide erzeugen gleichzeitig einen Schlüssel): der
 * Server nimmt per ON CONFLICT DO NOTHING den ERSTEN Wrap — der Verlierer
 * fasst nach dem Hochladen nach und übernimmt den fremden Schlüssel, BEVOR
 * er eine Zeile damit verschlüsselt. Ein verlorener Kanal-Schlüssel macht
 * sonst Zeilen unlesbar, die der andere Teilnehmer gerade eingereiht hat.
 */

import { auth } from '$lib/stores/auth.svelte';
import { archivEinliefern, archivKanalSchluessel } from '$lib/api/archiv';
import { oeffneKanalSchluessel, wickleKanalSchluessel } from './krypto';
import type { ArchivPaar } from './typen';

const SCHLUESSEL_LAENGE = 32;

/** Entsperrte Kanal-Schlüssel dieser Sitzung. */
const bereithaltend = new Map<string, Uint8Array>();

export type ArchivPubkeyZiel = { id: string; pubkey: string };

function bytesZuB64(bytes: Uint8Array): string {
	let binär = '';
	for (const b of bytes) binär += String.fromCharCode(b);
	return btoa(binär);
}

function vonB64(wert: string): Uint8Array {
	const binär = atob(wert);
	const bytes = new Uint8Array(binär.length);
	for (let i = 0; i < binär.length; i++) bytes[i] = binär.charCodeAt(i);
	return bytes;
}

/** Zufällige Zeilen-Id (63 Bit, dezimal) — Wiederholungen sind beim Server
 *  idempotent (ON CONFLICT DO NOTHING). */
export function erzeugeZufallsId(): string {
	const bytes = new Uint8Array(8);
	globalThis.crypto.getRandomValues(bytes);
	let wert = 0n;
	for (const b of bytes) wert = (wert << 8n) | BigInt(b);
	return (wert & 0x7fffffffffffffffn).toString();
}

/**
 * Der Kanal-Schlüssel — aus dem Sitzungsspeicher, vom Server geöffnet oder
 * (bei Erstanlage) frisch erzeugt und für beide Teilnehmer gewickelt.
 * Wirft bei Netz-/Krypto-Fehlern; die Aufrufer behandeln das als
 * „nicht archiviert“.
 */
export async function kanalSchluesselHolen(
	kanalId: string,
	paar: ArchivPaar,
	partnerId: string,
	fremdPubkey: string | null
): Promise<Uint8Array> {
	const ausSitzung = bereithaltend.get(kanalId);
	if (ausSitzung) return ausSitzung;

	const eigenerWrap = await archivKanalSchluessel(kanalId);
	if (eigenerWrap) {
		const schluessel = await oeffneKanalSchluessel(vonB64(eigenerWrap), paar.privkey, paar.pubkey);
		bereithaltend.set(kanalId, schluessel);
		return schluessel;
	}

	// Erstanlage NUR mit Partner-Public-Key (fail-closed): ohne ihn könnte
	// nur der Absender je öffnen — und ein zweiter Schlüssel des Partners
	// würde das Kanal-Universum SPLITTEN (dessen Zeilen wären für die
	// Gegenseite für immer unlesbar). Der nächste Sendeweg versucht es
	// erneut, wenn der Partner seinen Schlüssel eingerichtet hat.
	if (!fremdPubkey) {
		throw new Error('archiv: kein Archiv-Public-Key des Partners — Erstanlage vertagt');
	}
	const schluessel = new Uint8Array(SCHLUESSEL_LAENGE);
	globalThis.crypto.getRandomValues(schluessel);
	const kontoId = auth.user?.id;
	if (!kontoId) throw new Error('archiv: nicht angemeldet');
	const wraps: Array<{ channel_id: string; user_id: string; wrap_b64: string }> = [
		{
			channel_id: kanalId,
			user_id: kontoId,
			wrap_b64: bytesZuB64(await wickleKanalSchluessel(schluessel, paar.pubkey))
		}
	];
	if (fremdPubkey) {
		wraps.push({
			channel_id: kanalId,
			user_id: partnerId,
			wrap_b64: bytesZuB64(await wickleKanalSchluessel(schluessel, vonB64(fremdPubkey)))
		});
	}
	await archivEinliefern([], wraps);

	// Nachfassen (Wettlauf): hat ein anderes Gerät zwischendurch gewonnen,
	// steht dort ein FREMDER Wrap — übernehmen, damit die nächste Zeile
	// unter dem serverseitig gültigen Schlüssel läuft.
	const nochmal = await archivKanalSchluessel(kanalId);
	if (nochmal && nochmal !== wraps[0].wrap_b64) {
		const gewinner = await oeffneKanalSchluessel(vonB64(nochmal), paar.privkey, paar.pubkey);
		bereithaltend.set(kanalId, gewinner);
		return gewinner;
	}
	bereithaltend.set(kanalId, schluessel);
	return schluessel;
}

/** Kanal-Schlüssel verwerfen (Abmelden) — reine Sitzungshygiene. */
export function kanalSchluesselVerwerfen(kanalId?: string): void {
	if (kanalId) bereithaltend.delete(kanalId);
	else bereithaltend.clear();
}
