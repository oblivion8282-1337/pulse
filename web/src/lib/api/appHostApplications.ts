/**
 * API-Client für App-Hosting-Anträge (Stufe 2 — läuft auf dem Gerät des
 * Users, kein VPS/Hostname nötig). Disjoint zum Server-Hosting-Antrag
 * (``instances.ts``), aber sehr ähnlicher Shape — gespiegelt von den
 * Pydantic-Schemas in ``routes_app_host_applications.py`` (User) und
 * ``routes_admin_app_host.py`` (Admin).
 *
 * Approval setzt ``users.self_host_enabled=true`` in derselben Transaktion
 * → der Client muss danach polling/refresh triggern (LocalHosting prüft
 * das Flag live).
 *
 * Alle Endpoints sind cookie-auth'ed (``credentials:'include'``).
 */

import { cookieFetch } from './cookie-client';

// ---------------------------------------------------------------------------
// Typen — gespiegelt von den Pydantic-Schemas
// ---------------------------------------------------------------------------

export type AppHostApplicationStatus = 'pending' | 'approved' | 'rejected';
export type AppHostPurpose = 'privat' | 'verein' | 'firma' | 'sonst';

/** Spiegelt AppHostApplicationOut (User-Route). */
export interface AppHostApplication {
  id: string;
  user_id: string;
  purpose: AppHostPurpose;
  message: string | null;
  status: AppHostApplicationStatus;
  reviewed_at: string | null;
  rejection_reason: string | null;
  created_at: string;
}

/** Spiegelt AdminAppHostApplicationOut (Admin-Route — trägt applicant_username). */
export interface AdminAppHostApplication extends AppHostApplication {
  reviewed_by: string | null;
  applicant_username: string;
}

/** Spiegelt ApproveOut. */
export interface AppHostApproval {
  id: string;
  user_id: string;
  self_host_enabled: boolean;
}

// ---------------------------------------------------------------------------
// User-Endpoints (/me/*)
// ---------------------------------------------------------------------------

export const appHostApplicationsApi = {
  /** Antrag auf App-Hosting-Freischaltung einreichen. */
  submitApplication(payload: {
    purpose: AppHostPurpose;
    message?: string | null;
  }): Promise<AppHostApplication> {
    return cookieFetch<AppHostApplication>('/me/app-host-application', {
      method: 'POST',
      body: payload
    });
  },

  /** Eigene Anträge abrufen (optional nach Status gefiltert). */
  listMyApplications(
    status: 'all' | AppHostApplicationStatus = 'all'
  ): Promise<AppHostApplication[]> {
    const qs = status !== 'all' ? `?status=${status}` : '';
    return cookieFetch<AppHostApplication[]>(`/me/app-host-applications${qs}`);
  }
};

// ---------------------------------------------------------------------------
// Admin-Endpoints (/admin/*)
// ---------------------------------------------------------------------------

export const adminAppHostApplicationsApi = {
  /** Anträge abrufen, gefiltert nach Status (default pending). */
  listApplications(
    status: 'all' | AppHostApplicationStatus = 'pending'
  ): Promise<AdminAppHostApplication[]> {
    return cookieFetch<AdminAppHostApplication[]>(
      `/admin/app-host-applications?status=${status}`
    );
  },

  /** Antrag genehmigen — setzt self_host_enabled=true im selben Tx. */
  approveApplication(appId: string): Promise<AppHostApproval> {
    return cookieFetch<AppHostApproval>(
      `/admin/app-host-applications/${appId}/approve`,
      { method: 'POST' }
    );
  },

  /** Antrag ablehnen (mit reason). */
  rejectApplication(appId: string, reason: string): Promise<AdminAppHostApplication> {
    return cookieFetch<AdminAppHostApplication>(
      `/admin/app-host-applications/${appId}/reject`,
      { method: 'POST', body: { reason } }
    );
  }
};
