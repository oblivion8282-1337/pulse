/**
 * API-Client für das Missbrauchs-Meldewesen (Beschwerden gegen Instanzen,
 * Nutzer oder URLs).
 *
 * - Öffentliches Einreichen (`submitAbuseReport`): ohne Login, POST /reports
 *   (auth-svc), 3/h pro IP rate-limited.
 * - Cloud-Admin (`adminComplaintsApi`): Sichten + Lebenszyklus. Nutzt Cookie-Auth
 *   wie der Instanz-Admin (siehe api/instances.ts) — auth-svc prüft is_admin.
 *
 * Backend: services/auth/src/dcc_auth/routes_complaints.py
 */

import { AUTH_BASE, ApiError, getCloudBearer } from './client';
import { cookieFetch, extractDetail, safeParse } from './cookie-client';

// ---------------------------------------------------------------------------
// Typen — gespiegelt von ComplaintOut / ForwardResult im Backend
// ---------------------------------------------------------------------------

export type ComplaintStatus = 'new' | 'acknowledged' | 'forwarded' | 'resolved';

export interface Complaint {
  id: string;
  status: ComplaintStatus;
  submitted_at: string;
  body: string;
  target_url: string | null;
  target_instance_id: string | null;
  target_user_id: string | null;
  submitter_email: string | null;
  resolution_note: string | null;
  resolved_at: string | null;
  forwarded_at: string | null;
  forwarded_to_email: string | null;
  forward_notice: string | null;
  // Angereicherter Kontext (nur Admin-Liste).
  target_instance_hostname: string | null;
  operator_email: string | null;
  target_username: string | null;
}

/** Spiegelt ForwardResult — sagt, ob die E-Mail tatsächlich rausging. */
export interface ForwardResult {
  id: string;
  status: string;
  email_sent: boolean;
  email_error: string | null;
  forwarded_to_email: string | null;
}

export interface AbuseReportInput {
  body: string;
  target_url?: string | null;
  /** Gemeldeter Cloud-Nutzer (z.B. aus einer Direktnachricht-Meldung, die keinen
   *  Community-Moderator hat und deshalb ans Betreiberteam geht). */
  target_user_id?: string | null;
  submitter_email?: string | null;
}

// ---------------------------------------------------------------------------
// Öffentlich: Meldung einreichen (ohne Login)
// ---------------------------------------------------------------------------

export async function submitAbuseReport(
  payload: AbuseReportInput
): Promise<{ id: string; status: string }> {
  // Attach the caller's cloud bearer WHEN logged in, so the server can record
  // the reporter (server-derived — the reporter id is never sent in the body).
  // Anonymous reports simply omit it; the endpoint stays public.
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const bearer = await getCloudBearer().catch(() => null);
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
  const resp = await fetch(`${AUTH_BASE}/reports`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  if (resp.status === 201) {
    return (await resp.json()) as { id: string; status: string };
  }
  const text = await resp.text();
  const data = text ? safeParse(text) : null;
  throw new ApiError(resp.status, data, extractDetail(data) ?? resp.statusText);
}

// ---------------------------------------------------------------------------
// Cloud-Admin: Beschwerden sichten + bearbeiten
// ---------------------------------------------------------------------------

export const adminComplaintsApi = {
  /** Beschwerden nach Status abrufen (neueste zuerst). */
  list(status: ComplaintStatus = 'new'): Promise<Complaint[]> {
    return cookieFetch<Complaint[]>(`/admin/complaints?status=${status}`);
  },

  /** Als „in Bearbeitung" markieren. */
  acknowledge(id: string): Promise<{ id: string; status: string }> {
    return cookieFetch(`/admin/complaints/${id}/acknowledge`, { method: 'POST' });
  },

  /** An den Instanz-Betreiber weiterleiten (versendet E-Mail, wenn möglich). */
  forward(id: string, notice_text: string): Promise<ForwardResult> {
    return cookieFetch<ForwardResult>(`/admin/complaints/${id}/forward`, {
      method: 'POST',
      body: { notice_text }
    });
  },

  /** Als erledigt schließen. */
  resolve(id: string, resolution_note: string): Promise<{ id: string; status: string }> {
    return cookieFetch(`/admin/complaints/${id}/resolve`, {
      method: 'POST',
      body: { resolution_note }
    });
  },

  /** Dem gemeldeten Nutzer eine private Nachricht vom Betreiber schicken
   *  (umgeht die Freundschafts-Sperre). Nur möglich, wenn die Beschwerde
   *  einen Nutzer benennt. `sent` sagt, ob die DM tatsächlich rausging. */
  notifyUser(id: string, message: string): Promise<{ sent: boolean; error: string | null }> {
    return cookieFetch(`/admin/complaints/${id}/notify-user`, {
      method: 'POST',
      body: { message }
    });
  }
};
