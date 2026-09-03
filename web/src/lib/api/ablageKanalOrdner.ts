/**
 * Der Ordner-Kanal eines Nextcloud-verbundenen Kontos — REST-Client fuer
 * `PUT /channels/{id}/ablage/ordner` (Ordner anlegen), `GET
 * /channels/{id}/ablage/ordner` (Dateinamen) und `GET
 * /channels/{id}/ablage/ordner/{name}` (eine Zustellung daraus).
 *
 * Muster wie `./ablageArchiv.ts` — `request()` fuer JSON-Antworten,
 * `fetchAuthenticated()` dort, wo ein 404 kein Fehler, sondern ein
 * regulaerer Rueckgabewert (`null`) ist.
 *
 * **Beide Lesewege haben Geduld bei 429** (`ablage/geduld429.ts`). Der
 * Ordner-Verlauf holt beim ersten Oeffnen eines Kanals in kurzer Folge
 * Hunderte Dateien, und der Server begrenzt den Eimer `ablage_abruf` je
 * Nutzer und Minute — ohne Geduld brach der Verlauf ab der ersten Sperre
 * einfach ab und der Nutzer sah einen halben Kanal ohne Erklaerung. Dasselbe
 * Muster wie beim Archiv-Adapter, aus demselben Anlass (Dev-Stack,
 * 2026-09-02).
 */

import { ApiError, fetchAuthenticated, request, type RequestRoute } from './client';
import { extractDetail, safeParse } from './parse';
import { mitGeduldBei429 } from '../ablage/geduld429';
import type { PostfachZustellung } from './postfach';

/** Wo der Verlauf dieses Kanals liegt: bei Pulse (nur Chiffrat in der
 *  Datenbank) oder in der Nextcloud des Erstellers. */
export type OrdnerSpeicher = 'pulse' | 'nextcloud';

/** Legt den Ablage-Ordner fuer diesen Kanal an. Vorgabe `pulse` seit der
 *  Entscheidung vom 2026-09-03; nur der Nextcloud-Weg braucht ein
 *  Konto-Laufwerk und antwortet ohne eines mit 412 (der Aufrufer
 *  entscheidet, wie er das meldet). */
export async function ordnerAnlegen(
	kanalId: string,
	speicher: OrdnerSpeicher = 'pulse',
	route: RequestRoute = {}
): Promise<void> {
	// `body` als Objekt, nicht als fertiges JSON: `request()` kodiert selbst
	// (`client.ts`), ein `JSON.stringify` hier ergaebe eine doppelt kodierte
	// Zeichenkette.
	await request<void>(`/channels/${encodeURIComponent(kanalId)}/ablage/ordner`, {
		method: 'PUT',
		body: { speicher }
	}, route);
}

/** Die Dateinamen im Ordner, blattweise. `nach` = NUTZLAST-ID des zuletzt
 *  gesehenen Namens (Fortsetzung, s. `ablage/ordnerSeiten.ts`), `null` = von
 *  vorn; der Server antwortet 422 auf alles, was keine Zahl ist. Wirft
 *  `ApiError(404)`, wenn der Kanal kein Ordner-Kanal ist — kein `null`, das
 *  ist ein eigener Fehlerfall. */
export async function ordnerListe(
	kanalId: string,
	nach: string | null,
	limit: number,
	route: RequestRoute = {}
): Promise<string[]> {
	const params = new URLSearchParams({ limit: String(limit) });
	if (nach !== null) params.set('nach', nach);
	return mitGeduldBei429(() =>
		request<string[]>(
			`/channels/${encodeURIComponent(kanalId)}/ablage/ordner?${params.toString()}`,
			{},
			route
		)
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
		typeof z.groesse === 'number' &&
		// `created_at` ist optional (aeltere Server kennen das Feld noch
		// nicht, s. `api/postfach.ts`) — `undefined`, `null` und ein String
		// sind alle gueltig, nur ein anderer Typ nicht.
		(z.created_at === undefined || z.created_at === null || typeof z.created_at === 'string')
	);
}

/** Holt eine einzelne Datei aus dem Ordner als `PostfachZustellung` —
 *  `null`, wenn die Datei fehlt (404) ODER ihr Inhalt nicht der erwarteten
 *  Form entspricht (kaputte/fremde Datei im Ordner).
 *
 *  **Wer loescht hier?** Niemand. Die Dateien dieses Ordners entstehen beim
 *  Einliefern und werden von keinem Pfad im Klienten und von keinem
 *  Pflegelauf im Server wieder entfernt — ein 404 heisst also nicht
 *  „gerade weggeraeumt", sondern „diese Datei hat es nie gegeben" (Liste und
 *  Abruf liegen zeitlich auseinander, der Ordner liegt in einer fremden
 *  Cloud, in die auch sein Besitzer greifen kann). Uebersprungen wird sie so
 *  oder so. */
export async function ordnerDatei(
	kanalId: string,
	name: string,
	route: RequestRoute = {}
): Promise<PostfachZustellung | null> {
	const resp = await mitGeduldBei429(async () => {
		const antwort = await fetchAuthenticated(
			`/channels/${encodeURIComponent(kanalId)}/ablage/ordner/${encodeURIComponent(name)}`,
			{},
			route
		);
		// `fetchAuthenticated` wirft bei 429 nicht — die Geduld braucht aber
		// einen Wurf, um zu greifen (s. `geduld429.ts::istRatenbegrenzt`).
		if (antwort.status === 429) throw new ApiError(429, null, 'rate limited');
		return antwort;
	});
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
