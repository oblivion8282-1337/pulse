/**
 * Ablage-Kanal, Weiterreich-Route — Client fuer
 * ``routes/ablage_kanal.py::ablage_abruf`` (Etappe E7/E9, Design §4.2). Das
 * Gegenstueck zu ``api/ablageGuild.ts::abrufUrl`` fuer den Community-Weg, nur
 * dass hier tatsaechlich gelesen wird: der Umweg ist kein Link zum
 * Navigieren, sondern der ``ueberPulse``-Leser, den
 * ``ablage/direktMitRueckfall.ts`` erwartet.
 *
 * **Kein `request<T>`** — der Server antwortet mit rohen Bytes
 * (``application/octet-stream``, Chiffrat), kein JSON. `request` liest die
 * Antwort immer als Text und wuerde Binaerdaten dabei verstuemmeln. Der
 * Aufruf laeuft deshalb ueber `fetchAuthenticated` (derselbe Auth-/Direktpfad-
 * Kern wie `request`, exportiert aus `client.ts` genau fuer diesen Fall) und
 * liest die Antwort selbst als `ArrayBuffer`.
 *
 * **404 ist kein Fehler.** Die Route liefert 404, wenn kein Laufwerk
 * verbunden ist ODER die angefragte Datei dort fehlt (`ablage_ssrf.py`
 * unterscheidet das serverseitig nicht extra) — beides bedeutet fuer den
 * Leser dasselbe wie bei jedem anderen `AblageAdapter.lese`: `null`.
 *
 * **Nichts hiervon wird geloggt.** Weder der Pfad noch das Ergebnis — ein
 * Fehlschlag traegt nur den HTTP-Status und den maschinenlesbaren Code aus
 * der Server-Antwort (s. `ablage_kanal.py::_STATUS_JE_CODE`), nie die
 * Freigabe-Adresse, die der Server ohnehin nie herausgibt.
 *
 * **`ablageKanalLaufwerkSetzen`** ist das Gegenstueck fuer
 * ``PUT .../ablage/laufwerk``: gewoehnliches JSON, deshalb ueber `request`
 * (nicht `fetchAuthenticated` wie beim Abruf oben, der Rohbytes braucht).
 * Nur das erste erfolgreiche PUT eines Kanals legt dessen `ersteller_id`
 * fest (Server-Docstring); jedes weitere PUT eines ANDEREN Kontos antwortet
 * 403 — das reicht als `ApiError` beim Aufrufer durch, hier keine eigene
 * Sonderbehandlung.
 */

import { ApiError, fetchAuthenticated, request, type RequestRoute } from './client';
import { safeParse, extractDetail } from './parse';

/**
 * Liest `pfad` relativ zur Freigabe-Adresse des Kanal-Laufwerks, ueber den
 * Pulse-Server. `null`, wenn die Route 404 antwortet (kein Laufwerk oder
 * Datei fehlt dort). Jeder andere Fehlschlag wirft `ApiError`.
 */
export async function ablageKanalAbruf(
  kanalId: string,
  pfad: string,
  route: RequestRoute = {}
): Promise<Uint8Array | null> {
  const params = new URLSearchParams({ pfad });
  const resp = await fetchAuthenticated(
    `/channels/${kanalId}/ablage/abruf?${params.toString()}`,
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

/**
 * Hinterlegt die Freigabe-Adresse fuer `kanalId` (`PUT .../ablage/laufwerk`).
 * Wirft `ApiError(403, …)`, wenn der Kanal bereits ein Laufwerk eines
 * ANDEREN Kontos hat — der Aufrufer entscheidet, wie er das dem Nutzer sagt.
 */
export async function ablageKanalLaufwerkSetzen(
  kanalId: string,
  freigabeAdresse: string,
  route: RequestRoute = {}
): Promise<void> {
  await request<void>(
    `/channels/${kanalId}/ablage/laufwerk`,
    { method: 'PUT', body: { freigabe_adresse: freigabeAdresse } },
    route
  );
}

/**
 * Legt `inhalt` unter `pfad` auf dem Kanal-Laufwerk ab — ueber den
 * Pulse-Server, nicht direkt.
 *
 * **Direkt geht nicht**, und das ist gemessen: eine Nextcloud setzt auf ein
 * WebDAV-`PUT` aus dem Browser keine CORS-Kopfzeile, der Aufruf bricht vor
 * dem ersten Byte ab (2026-09-01). Der Entwurf sah den Weg ohnehin ueber
 * Pulse vor (§1, §4.0a) — er war nur nicht gebaut, und weil die Festigung
 * in einer Hintergrundschleife lief, blieb der Fehlschlag unsichtbar: der
 * Cloud-Ordner blieb leer, ohne dass irgendwo etwas rot wurde.
 *
 * Schreiben darf nur der Ersteller des Laufwerks; ein anderes Mitglied
 * bekommt 403 (`ApiError`).
 */
export async function ablageKanalSchreiben(
  kanalId: string,
  pfad: string,
  inhalt: Uint8Array,
  route: RequestRoute = {}
): Promise<void> {
  const params = new URLSearchParams({ pfad });
  const resp = await fetchAuthenticated(
    `/channels/${kanalId}/ablage/schreiben?${params.toString()}`,
    {
      method: 'PUT',
      // `Uint8Array` statt `Blob`: der Koerper ist Chiffrat, ein
      // Inhaltstyp waere eine Aussage darueber, die wir nicht treffen.
      body: inhalt as unknown as BodyInit
    },
    route
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const data = text ? safeParse(text) : null;
    throw new ApiError(resp.status, data, extractDetail(data) ?? resp.statusText);
  }
}

/**
 * Die Dateinamen im Laufwerks-Ordner des Kanals — ueber den Pulse-Server.
 *
 * **Auch das geht nicht direkt:** ein WebDAV-`PROPFIND` loest im Browser
 * eine CORS-Vorabfrage aus und scheitert an derselben Wand wie das
 * Schreiben. Die Bestandsaufnahme vor jedem Festigen beginnt aber damit.
 */
export async function ablageKanalListe(
  kanalId: string,
  route: RequestRoute = {}
): Promise<string[]> {
  return request<string[]>(`/channels/${kanalId}/ablage/liste`, {}, route);
}
