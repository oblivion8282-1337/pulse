/**
 * GET /meine-anhaenge — eigene Anhang-Metadaten, newest-first, seitenweise
 * (Stufe A1, `routes/meine_anhaenge.py`). Schmaler Klient für den Medien-
 * Nachzug (`verlauf/medienNachzug.ts`); Bytes/URLs liefert die Route
 * bewusst nicht.
 *
 * Die Route hängt ohne Prefix im Wurzel-Router des chat-gateway (wie
 * `/gruppen`, nicht `/chat/gruppen`) — `request` baut `/api/chat` davor.
 * Bewusst OHNE erzwungene Cloud-Route: Anhänge gehören zum jeweiligen
 * Server (Klartext-Weg läuft auch gegen einen Self-Host), der aktive
 * Server ist der richtige Adressat.
 */

import { request } from './client';
import type { ServerAnhang } from '$lib/verlauf/medienNachzug';

export const meineAnhaengeApi = {
  /** Eine Seite eigener Anhang-Metadaten. `before` (exklusiv) = letzte
   *  gesehene id; `null` = vom neuesten Anfang. `limit ≤ 100` (Server). */
  auflisten(before: string | null, limit: number): Promise<ServerAnhang[]> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (before !== null) query.set('before', before);
    return request<ServerAnhang[]>(`/meine-anhaenge?${query}`);
  }
};
