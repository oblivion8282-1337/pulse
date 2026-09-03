/**
 * Das Cloud-Laufwerk des persönlichen Archivs — über den Pulse-Server.
 *
 * **Warum der Umweg, obwohl es der eigene Ordner ist.** Rein technisch: ein
 * Browser kann in eine fremde Cloud nicht schreiben, weil deren Server keine
 * CORS-Kopfzeilen setzt — an einer echten Nextcloud gemessen (2026-09-01:
 * weder auf die Vorabfrage noch auf das echte `PUT` kommt eine
 * `Access-Control-Allow-Origin`-Kopfzeile zurück, während derselbe Aufruf
 * serverseitig 201 liefert). Ohne diesen Weg gäbe es das persönliche Archiv
 * nur auf einem lokalen Ordner — also genau dort, wo es seinen Zweck nicht
 * erfüllt: den Verlauf auf einem NEUEN Gerät zurückzuholen.
 *
 * Das deckt sich mit der Entscheidung „je ein Schreib-Link, den nur Pulse
 * kennt" (2026-08-31); dies ist der dritte davon, neben Kanal und Community.
 *
 * **Der Server bekommt nur Chiffrat.** Verschlüsselt wird eine Schicht
 * darüber (`DateiSpeicher` mit dem Hauptschlüssel der Verbindung), bevor
 * irgendetwas hier ankommt.
 */

import { ApiError, fetchAuthenticated, request, type RequestRoute } from './client';
import { extractDetail, safeParse } from './parse';
import { serversStore } from './servers.svelte';

/**
 * **Jeder Aufruf hier geht an die CLOUD, nicht an den aktiven Server.**
 *
 * Das Archiv-Laufwerk hängt am Konto, und das Konto lebt in der Cloud: dort
 * wird die Freigabe-Adresse hinterlegt, und dort legt der Server beim
 * Versenden einer verschlüsselten DM das Chiffrat in den Archiv-Ordner jedes
 * Beteiligten. Ein Aufruf ohne Route landet in `client.ts` beim AKTIVEN
 * Server — und ist das ein Self-Host, fragt der Empfänger den falschen
 * Rechner nach seiner Datei. Genau so am 2026-09-03 passiert: mit aktivem
 * Self-Host beantwortete dieser `GET /ablage/archiv/abruf` mit 404, der
 * Rückfall auf Pulses eigene Kopie fand nichts mehr (sie ist nach der
 * Verteilung freigegeben), und ein frisch empfangener Anhang blieb bis zum
 * Reload leer. Dieselbe Falle wie bei `ws/gapFill.ts` am selben Tag, nur in
 * REST-Form — deshalb steht die Route hier EINMAL als Vorgabe und nicht in
 * jedem Aufrufer.
 */
function cloudRoute(): RequestRoute {
	return { serverId: serversStore.cloudId() };
}

/** Hinterlegt die Freigabe-Adresse des Archivs. Ein zweiter Aufruf ersetzt
 *  sie — wer sein Archiv umzieht, soll das ohne Umweg können. */
export async function archivLaufwerkSetzen(
	freigabeAdresse: string,
	route: RequestRoute = cloudRoute()
): Promise<void> {
	await request<void>(
		'/ablage/archiv/laufwerk',
		{ method: 'PUT', body: { freigabe_adresse: freigabeAdresse } },
		route
	);
}

/**
 * Nimmt die Freigabe-Adresse beim Server wieder weg — der Widerruf.
 *
 * **Ohne diesen Aufruf ist ein Trennen keins.** Bis zum 2026-09-01 räumte
 * die Oberfläche nur den lokalen Eintrag weg; der Server behielt die
 * Adresse, meldete das Konto weiter als anhang-bereit und hätte in einen
 * abgehängten Ordner geschrieben. Der Zwei-Browser-Nachweis hat genau das
 * gemessen.
 *
 * Serverseitig idempotent (204 auch ohne hinterlegte Adresse) — der
 * Aufrufer muss also nicht wissen, ob je eine da war.
 */
export async function archivLaufwerkTrennen(route: RequestRoute = cloudRoute()): Promise<void> {
	await request<void>('/ablage/archiv/laufwerk', { method: 'DELETE' }, route);
}

/** Legt `inhalt` unter `pfad` im Archiv-Ordner ab. */
export async function archivSchreiben(
	pfad: string,
	inhalt: Uint8Array,
	route: RequestRoute = cloudRoute()
): Promise<void> {
	const params = new URLSearchParams({ pfad });
	const resp = await fetchAuthenticated(
		`/ablage/archiv/schreiben?${params.toString()}`,
		{ method: 'PUT', body: inhalt as unknown as BodyInit },
		route
	);
	if (!resp.ok) {
		const text = await resp.text().catch(() => '');
		const data = text ? safeParse(text) : null;
		throw new ApiError(resp.status, data, extractDetail(data) ?? resp.statusText);
	}
}

/** Holt `pfad` aus dem Archiv-Ordner. `null`, wenn es die Datei dort nicht
 *  gibt — beim ersten Lauf ist das der Normalfall, kein Fehler. */
export async function archivAbruf(
	pfad: string,
	route: RequestRoute = cloudRoute()
): Promise<Uint8Array | null> {
	const params = new URLSearchParams({ pfad });
	const resp = await fetchAuthenticated(
		`/ablage/archiv/abruf?${params.toString()}`,
		{},
		route
	);
	if (resp.status === 404) return null;
	if (!resp.ok) {
		const text = await resp.text().catch(() => '');
		const data = text ? safeParse(text) : null;
		throw new ApiError(resp.status, data, extractDetail(data) ?? resp.statusText);
	}
	return new Uint8Array(await resp.arrayBuffer());
}

/** Die Dateinamen im Archiv-Ordner. */
/** Entfernt eine Datei aus dem Archiv-Ordner — ein 404 dort ist Erfolg
 *  (`ablage_schreiben.loesche`). */
export async function archivLoeschen(pfad: string, route: RequestRoute = cloudRoute()): Promise<void> {
	const params = new URLSearchParams({ pfad });
	await request<void>(`/ablage/archiv/datei?${params.toString()}`, { method: 'DELETE' }, route);
}

export async function archivListe(route: RequestRoute = cloudRoute()): Promise<string[]> {
	return request<string[]>('/ablage/archiv/liste', {}, route);
}
