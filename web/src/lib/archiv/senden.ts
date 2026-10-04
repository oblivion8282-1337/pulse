/**
 * Einlieferung in den Server-Archiv (Übergabe 2026-10-04, §5): JEDE
 * verschlüsselte DM wird nach erfolgreicher Zustellung zusätzlich
 * verschlüsselt beim Server abgelegt (120 Tage). Fire-and-forget — das
 * Archiv darf die Nachricht nie aufhalten; ein Fehlschlag wird still
 * (console.warn) und der Verlauf bleibt lokal die wahre Kopie.
 *
 * Reihenfolge im Absendeweg (`krypto/senden.ts`): NACH dem
 * `verlaufSpeichernPflicht` + DM-Listen-Nachzug, VOR dem Return.
 *
 * Der Partner-Wrap reist bei JEDER Einlieferung mit (ON CONFLICT DO
 * NOTHING macht Wiederholungen billig): hatte die Gegenseite beim ersten
 * Senden noch keinen Archiv-Public-Key, richtet ein späteres Senden ihren
 * Zugang nach — ohne Extra-Endpunkt und ohne Existenz-Rückfrage.
 */

import { auth } from '$lib/stores/auth.svelte';
import type { Message } from '$lib/api/types';
import { archivEinliefern, archivPubkeys } from '$lib/api/archiv';
import { erzeugeZufallsId, kanalSchluesselHolen } from './kanalSchluessel';
import { verschluessleZeile, wickleKanalSchluessel } from './krypto';
import { archivPaar } from './konto';

/** Eine laufende Einlieferung je Kanal — zwei schnelle Nachrichten serialisieren. */
const laufend = new Map<string, Promise<void>>();

/**
 * Archiviert eine GESENDETE verschlüsselte DM. Wirft nie.
 */
export function archiviereGesendet(kanalId: string, empfaengerId: string, nachricht: Message): void {
	const vorher = laufend.get(kanalId) ?? Promise.resolve();
	const lauf = vorher
		.then(() => einliefern(kanalId, empfaengerId, nachricht))
		.catch((e) => console.warn('[archiv] Einlieferung fehlgeschlagen', e))
		.finally(() => {
			if (laufend.get(kanalId) === lauf) laufend.delete(kanalId);
		});
	laufend.set(kanalId, lauf);
}

async function einliefern(
	kanalId: string,
	empfaengerId: string,
	nachricht: Message
): Promise<void> {
	const kontoId = auth.user?.id;
	if (!kontoId) return;
	const paar = await archivPaar(kontoId);
	if (!paar) return; // Archiv auf diesem Gerät nicht entsperrt — kein Zwang

	const pubkeys = await archivPubkeys([kontoId, empfaengerId]);
	const fremd = pubkeys[empfaengerId] ?? null;

	// Kanal-Schlüssel zuerst (Erstanlage wickelt hier für beide Seiten).
	const kanalSchluessel = await kanalSchluesselHolen(kanalId, paar, empfaengerId, fremd);

	// Textzeile: content + Threading-Metadaten als JSON. Anhänge bleiben
	// Durchlauferhitzer (§5.4) — ihre ANGABEN reisen im Text mit, die Bytes nicht.
	const klar = new TextEncoder().encode(
		JSON.stringify({
			i: nachricht.id,
			t: nachricht.content,
			a: nachricht.author_id,
			z: nachricht.created_at,
			...(nachricht.reply_to_id ? { r: nachricht.reply_to_id } : {}),
			...(nachricht.attachments?.length ? { v: nachricht.attachments.length } : {})
		})
	);
	const nutzlast = await verschluessleZeile(kanalSchluessel, klar);

	// Partner-Wrap immer mitschicken — Selbstheilung für Konten, die nach
	// der Erstanlage ihren Public-Key bekommen haben (s. Modulkopf).
	const fremdWraps =
		fremd !== null
			? [
					{
						channel_id: kanalId,
						user_id: empfaengerId,
						wrap_b64: bytesZuB64(await wickleKanalSchluessel(kanalSchluessel, vonB64(fremd)))
					}
				]
			: [];

	await archivEinliefern(
		[
			{
				id: erzeugeZufallsId(),
				channel_id: kanalId,
				nutzlast_b64: bytesZuB64(nutzlast)
			}
		],
		fremdWraps
	);
}

function vonB64(wert: string): Uint8Array {
	const binär = atob(wert);
	const bytes = new Uint8Array(binär.length);
	for (let i = 0; i < binär.length; i++) bytes[i] = binär.charCodeAt(i);
	return bytes;
}

function bytesZuB64(bytes: Uint8Array): string {
	let binär = '';
	for (const b of bytes) binär += String.fromCharCode(b);
	return btoa(binär);
}
