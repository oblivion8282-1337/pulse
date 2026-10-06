/**
 * Der Kanal-Schlüssel je Kanal (DM oder private Gruppe, Übergabe
 * 2026-10-04 §5; Gruppen seit 2026-10-05): 32 Zufallsbytes, verschlüsselt
 * beim Server als Wrap an den Archiv-Public-Key je Teilnehmer.
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

/** Bereits (dieser Sitzung) für den Server gewickelte Empfänger — Key
 *  `${kanalId}:${nutzerId}:${pubkey}`. Self-Healing reicht einmal je
 *  Sitzung: der Server nimmt Wraps idempotent an (ON CONFLICT DO NOTHING),
 *  jede Folge-Sendung ohne diese Map schickte bis zu 50 identischen
 *  Wraps erneut mit (Gruppen). */
const gewickeltFuer = new Set<string>();

export type ArchivPubkeyZiel = { id: string; pubkey: string };

/** Ein Wrap-Auftrag für den Server, wie `archivEinliefern` ihn nimmt. */
type ArchivWrapAuftrag = { channel_id: string; user_id: string; wrap_b64: string };

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
 * (bei Erstanlage) frisch erzeugt und für ALLE übergebenen Ziele gewickelt.
 * Rückgabe: der Schlüssel PLUS die Wraps, die diese Sitzung noch nicht
 * hochgeladen hat — der Aufrufer legt sie mit der nächsten Zeile mit ab.
 * Wirft bei Netz-/Krypto-Fehlern; die Aufrufer behandeln das als
 * „nicht archiviert“.
 *
 * `ziele` sind die ANDEREN Kanal-Teilnehmer mit bekanntem Archiv-Public-Key
 * (bei einer DM der eine Partner, bei einer privaten Gruppe die Mitglieder —
 * Konten ohne Schlüssel fallen aus, ihre Wraps heilt eine spätere Sendung
 * nach).
 *
 * Erstanlage NUR mit mindestens einem Fremd-Key (fail-closed): ohne ihn
 * könnte nur der Absender je öffnen — und ein zweiter Schlüssel eines
 * anderen Teilnehmers würde das Kanal-Universum SPLITTEN (dessen Zeilen
 * wären für die Gegenseite für immer unlesbar). Der nächste Sendeweg
 * versucht es erneut.
 */
export async function kanalSchluesselHolen(
	kanalId: string,
	paar: ArchivPaar,
	ziele: ArchivPubkeyZiel[]
): Promise<{ schluessel: Uint8Array; wraps: ArchivWrapAuftrag[] }> {
	const ausSitzung = bereithaltend.get(kanalId);
	if (ausSitzung) return { schluessel: ausSitzung, wraps: await nachwickeln(kanalId, ausSitzung, ziele) };

	const eigenerWrap = await archivKanalSchluessel(kanalId);
	if (eigenerWrap) {
		const schluessel = await oeffneKanalSchluessel(vonB64(eigenerWrap), paar.privkey, paar.pubkey);
		bereithaltend.set(kanalId, schluessel);
		return { schluessel, wraps: await nachwickeln(kanalId, schluessel, ziele) };
	}

	if (ziele.length === 0) {
		throw new Error('archiv: kein Archiv-Public-Key eines Teilnehmers — Erstanlage vertagt');
	}
	const schluessel = new Uint8Array(SCHLUESSEL_LAENGE);
	globalThis.crypto.getRandomValues(schluessel);
	const kontoId = auth.user?.id;
	if (!kontoId) throw new Error('archiv: nicht angemeldet');
	const wraps: ArchivWrapAuftrag[] = [
		{
			channel_id: kanalId,
			user_id: kontoId,
			wrap_b64: bytesZuB64(await wickleKanalSchluessel(schluessel, paar.pubkey))
		}
	];
	for (const ziel of ziele) {
		wraps.push({
			channel_id: kanalId,
			user_id: ziel.id,
			wrap_b64: bytesZuB64(await wickleKanalSchluessel(schluessel, vonB64(ziel.pubkey)))
		});
		gewickeltFuer.add(kanalId + ':' + ziel.id + ':' + ziel.pubkey);
	}
	await archivEinliefern([], wraps);

	// Nachfassen (Wettlauf): hat ein anderes Gerät zwischendurch gewonnen,
	// steht dort ein FREMDER Wrap — übernehmen, damit die nächste Zeile
	// unter dem serverseitig gültigen Schlüssel läuft.
	const nochmal = await archivKanalSchluessel(kanalId);
	if (nochmal && nochmal !== wraps[0].wrap_b64) {
		const gewinner = await oeffneKanalSchluessel(vonB64(nochmal), paar.privkey, paar.pubkey);
		bereithaltend.set(kanalId, gewinner);
		return { schluessel: gewinner, wraps: [] };
	}
	bereithaltend.set(kanalId, schluessel);
	return { schluessel, wraps: [] };
}

/** Wraps für Ziele, die sie dieser Sitzung noch nicht bekommen haben —
 *  Selbstheilung für nachgerüstete Konten und neue Gruppen-Mitglieder. */
async function nachwickeln(
	kanalId: string,
	schluessel: Uint8Array,
	ziele: ArchivPubkeyZiel[]
): Promise<ArchivWrapAuftrag[]> {
	const wraps: ArchivWrapAuftrag[] = [];
	for (const ziel of ziele) {
		const merkmal = kanalId + ':' + ziel.id + ':' + ziel.pubkey;
		if (gewickeltFuer.has(merkmal)) continue;
		wraps.push({
			channel_id: kanalId,
			user_id: ziel.id,
			wrap_b64: bytesZuB64(await wickleKanalSchluessel(schluessel, vonB64(ziel.pubkey)))
		});
		gewickeltFuer.add(merkmal);
	}
	return wraps;
}

/** Kanal-Schlüssel verwerfen (Abmelden) — reine Sitzungshygiene. */
export function kanalSchluesselVerwerfen(kanalId?: string): void {
	if (kanalId) bereithaltend.delete(kanalId);
	else bereithaltend.clear();
}
