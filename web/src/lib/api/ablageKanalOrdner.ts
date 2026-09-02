/**
 * Der Ordner-Kanal eines Nextcloud-verbundenen Kontos — REST-Client fuer
 * `PUT /channels/{id}/ablage/ordner` (Ordner anlegen), `GET
 * /channels/{id}/ablage/ordner` (Dateinamen) und `GET
 * /channels/{id}/ablage/ordner/{name}` (eine Zustellung daraus).
 *
 * Muster wie `./ablageArchiv.ts` — `request()` fuer JSON-Antworten,
 * `fetchAuthenticated()` dort, wo ein 404 kein Fehler, sondern ein
 * regulaerer Rueckgabewert (`null`) ist.
 */

import { ApiError, fetchAuthenticated, request, type RequestRoute } from './client';
import { extractDetail, safeParse } from './parse';
import type { PostfachZustellung } from './postfach';

/** Legt den Ablage-Ordner fuer diesen Kanal an — 412, wenn der Aufrufer
 *  kein Konto-Laufwerk verbunden hat (Aufrufer entscheidet, wie er das
 *  meldet). */
export async function ordnerAnlegen(kanalId: string, route: RequestRoute = {}): Promise<void> {
	await request<void>(`/channels/${encodeURIComponent(kanalId)}/ablage/ordner`, {
		method: 'PUT'
	}, route);
}

/** Die Dateinamen im Ordner, blattweise. `nach` = zuletzt gesehener Name
 *  (Fortsetzung), `null` = von vorn. Wirft `ApiError(404)`, wenn der Kanal
 *  kein Ordner-Kanal ist — kein `null`, das ist ein eigener Fehlerfall. */
export async function ordnerListe(
	kanalId: string,
	nach: string | null,
	limit: number,
	route: RequestRoute = {}
): Promise<string[]> {
	const params = new URLSearchParams({ limit: String(limit) });
	if (nach !== null) params.set('nach', nach);
	return request<string[]>(
		`/channels/${encodeURIComponent(kanalId)}/ablage/ordner?${params.toString()}`,
		{},
		route
	);
}

/** Prueft, ob `wert` die Form der Wire-Felder von `PostfachZustellung`
 *  hat — Strings/Zahlen genau wie dort deklariert. */
function istPostfachZustellung(wert: unknown): wert is PostfachZustellung {
	if (!wert || typeof wert !== 'object') return false;
	const z = wert as Record<string, unknown>;
	return (
		typeof z.id === 'string' &&
		typeof z.channel_id === 'string' &&
		typeof z.absender_device_pubkey === 'string' &&
		(typeof z.absender_curve25519 === 'string' || z.absender_curve25519 === null) &&
		(typeof z.absender_user_id === 'string' || z.absender_user_id === null) &&
		typeof z.art === 'number' &&
		typeof z.daten === 'string' &&
		typeof z.groesse === 'number'
	);
}

/** Holt eine einzelne Datei aus dem Ordner als `PostfachZustellung` —
 *  `null`, wenn die Datei fehlt (404, Normalfall bei einem Wettlauf mit
 *  `archivLoeschen` auf der Gegenseite) ODER ihr Inhalt nicht der
 *  erwarteten Form entspricht (kaputte/fremde Datei im Ordner). */
export async function ordnerDatei(
	kanalId: string,
	name: string,
	route: RequestRoute = {}
): Promise<PostfachZustellung | null> {
	const resp = await fetchAuthenticated(
		`/channels/${encodeURIComponent(kanalId)}/ablage/ordner/${encodeURIComponent(name)}`,
		{},
		route
	);
	if (resp.status === 404) return null;
	if (!resp.ok) {
		const text = await resp.text().catch(() => '');
		const data = text ? safeParse(text) : null;
		throw new ApiError(resp.status, data, extractDetail(data) ?? resp.statusText);
	}
	let wert: unknown;
	try {
		wert = await resp.json();
	} catch {
		return null;
	}
	return istPostfachZustellung(wert) ? wert : null;
}
