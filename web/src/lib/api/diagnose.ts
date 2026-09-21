/**
 * Admin-API für Diagnose-Berichte (Spec 2026-09-21 §6).
 *
 * Liest/schreibt `experimental_logs` über die Cloud (Super-Admin only, der
 * Endpoint prüft `_require_admin` + `_require_cloud` selbst). Bewusst dieselbe
 * Cookie-Auth wie `instances.ts` — die Ansicht ist Cloud-only und sitzt im
 * Admin-Panel neben den Instanzen.
 */

import { cookieFetch } from './cookie-client';
import { request } from './client';

/** Zeile der Liste — ohne report/log_text (die holt das Detail). */
export interface DiagnoseListeEintrag {
  id: string;
  created_at: string;
  reason: string | null;
  role: string | null;
  channel_id: string | null;
  sidecar_version: string | null;
  client_ip: string | null;
  system_info: Record<string, unknown> | null;
}

/** Detail: Liste + der volle Bericht (Kopf/Bilanz/Ereignisse) + Rohtext. */
export interface DiagnoseDetails extends DiagnoseListeEintrag {
  report: Record<string, unknown> | null;
  log_text: string | null;
}

export type DiagnoseRolleFilter = '' | 'app' | 'viewer' | 'sender' | 'server';

export const adminDiagnoseApi = {
  /** Berichte auflisten, neueste zuerst. `role: ''` = alle. */
  list(
    role: DiagnoseRolleFilter = '',
    limit = 50,
    beforeId?: string
  ): Promise<DiagnoseListeEintrag[]> {
    const qs = new URLSearchParams();
    if (role) qs.set('role', role);
    if (beforeId) qs.set('before_id', beforeId);
    qs.set('limit', String(limit));
    return cookieFetch<DiagnoseListeEintrag[]>(`/admin/experimental-logs?${qs.toString()}`);
  },

  /** Voller Bericht inkl. Kopf/Ereignisse/Rohtext. */
  hole(id: string): Promise<DiagnoseDetails> {
    return cookieFetch<DiagnoseDetails>(`/admin/experimental-logs/${id}`);
  },

  /** Einzellöschung (Spot-Fall); regulär räumt die 28-Tage-Frist. */
  loeschen(id: string): Promise<void> {
    return cookieFetch<void>(`/admin/experimental-logs/${id}`, { method: 'DELETE' });
  }
};

/**
 * Server-Paket eines Self-Hosters einreichen (Spec §7, Phase 3).
 *
 * Läuft über `request(..., endpoint: 'auth')` — die Identity-Plane ist immer
 * Cloud-relativ (s. `client.ts::buildUrl`), der Bearer ist der Cloud-Account
 * des Betreibers. Die Cloud prüft die Owner-Membership der Instanz; der
 * Server selbst ruft die Cloud nie an — der Browser ist der Kurier.
 */
export async function reicheServerPaketEin(
  instanceId: string,
  paket: Record<string, unknown>
): Promise<void> {
  await request<void>('/me/instance-diagnose', {
    method: 'POST',
    endpoint: 'auth',
    body: { instance_id: instanceId, paket }
  });
}
