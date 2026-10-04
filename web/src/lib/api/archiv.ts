/**
 * REST-Anbindung des DM-Archivs (Übergabe 2026-10-04, §5).
 *
 * Zwei Dienste: Zeilen + Kanal-Schlüssel-Wraps liegen beim chat-gateway
 * (`/archiv…`, endpoint 'chat'), der Konto-Schlüssel (zweifach gewrappter
 * Privatschlüssel + Public-Key) beim auth-Dienst (`/me/archiv-schluessel`,
 * endpoint 'auth'). Der Klient ist der Bote zwischen beiden — der Server
 * sieht nie Klartext.
 */

import { request, ApiError } from './client';

// --- chat-gateway: Zeilen + Kanal-Wraps --------------------------------------

export interface ArchivZeileFern {
	id: string;
	channel_id: string;
	nutzlast_b64: string;
	erstellt_at: string;
}

export async function archivEinliefern(zeilen: Array<{ id: string; channel_id: string; nutzlast_b64: string }>, wraps: Array<{ channel_id: string; user_id: string; wrap_b64: string }>): Promise<void> {
	if (zeilen.length === 0 && wraps.length === 0) return;
	await request<void>(
		'/archiv',
		{
			method: 'POST',
			endpoint: 'chat',
			// Ids als STRINGS in JSON — Number() verliert bei Snowflake-Ids
			// (17 Stellen > 2^53) Präzision, der Server sah dann falsche Kanäle.
			// Pydantic wandelt Ziffern-Strings beim Server sauber nach int.
			body: {
				zeilen: zeilen.map((z) => ({ id: String(z.id), channel_id: String(z.channel_id), nutzlast_b64: z.nutzlast_b64 })),
				wraps: wraps.map((w) => ({ channel_id: String(w.channel_id), user_id: String(w.user_id), wrap_b64: w.wrap_b64 }))
			}
		}
	);
}

export async function archivSeite(channelId: string, vorId?: string, limit = 500): Promise<ArchivZeileFern[]> {
	const query = new URLSearchParams({ limit: String(limit) });
	if (vorId) query.set('vor_id', vorId);
	return request<ArchivZeileFern[]>(`/archiv/${channelId}?${query.toString()}`, { endpoint: 'chat' });
}

/** Der eigene Kanal-Schlüssel-Wrap — `null` heißt „noch keiner hinterlegt“. */
export async function archivKanalSchluessel(channelId: string): Promise<string | null> {
	const erg = await request<{ wrap_b64: string | null }>(
		`/archiv/${channelId}/schluessel`,
		{ endpoint: 'chat' }
	);
	return erg.wrap_b64;
}

/** Archiv-Public-Keys eigener DM-Partner (`null` = Konto hat keins eingerichtet). */
export async function archivPubkeys(userIds: string[]): Promise<Record<string, string | null>> {
	if (userIds.length === 0) return {};
	return request<Record<string, string | null>>(
		`/archiv/pubkeys?user_ids=${userIds.join(',')}`,
		{ endpoint: 'chat' }
	);
}

// --- auth-Dienst: Konto-Schlüssel --------------------------------------------

export interface ArchivKontoSchluessel {
	pubkey_b64: string;
	kdf_salt_b64: string;
	wrap_kdf_b64: string;
}

export async function archivKontoLesen(): Promise<ArchivKontoSchluessel | null> {
	try {
		return await request<ArchivKontoSchluessel>('/me/archiv-schluessel', { endpoint: 'auth' });
	} catch (e) {
		if (e instanceof ApiError && e.status === 404) return null;
		throw e;
	}
}

/** Erstanlage — der rohe Privatschlüssel reist EINMAL (TLS), der Server
 *  wickelt ihn zusätzlich unter das Schrank-Geheimnis. */
export async function archivKontoAnlegen(angabe: {
	pubkey_b64: string;
	kdf_salt_b64: string;
	wrap_kdf_b64: string;
	privkey_b64: string;
}): Promise<void> {
	await request<void>('/me/archiv-schluessel', { method: 'PUT', body: angabe, endpoint: 'auth' });
}

/** Re-Wrap nach Passwortwechsel (clientseitig neu gewickelt). */
export async function archivKontoNeuwickeln(angabe: { kdf_salt_b64: string; wrap_kdf_b64: string }): Promise<void> {
	await request<void>('/me/archiv-schluessel', { method: 'PATCH', body: angabe, endpoint: 'auth' });
}
