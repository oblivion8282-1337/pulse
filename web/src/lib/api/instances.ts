/**
 * API-Client für Phase 2.5 — Self-Host Instance-Registry.
 *
 * Alle User-Endpoints nutzen Cookie-Auth (pulse_session HttpOnly) via
 * credentials:'include'. Admin-Endpoints ebenfalls — auth-svc prüft
 * is_admin server-seitig.
 *
 * Wichtig: ApprovalOut.client_secret NIE in console.log/localStorage/
 * sessionStorage speichern — nur transient im UI anzeigen.
 *
 * Backend-Quelle:
 *   routes_instance_applications.py (User)
 *   routes_admin_instances.py       (Admin)
 */

import { AUTH_BASE, ApiError } from './client';
import { cookieFetch, renewSession, safeParse, extractDetail } from './cookie-client';

// ---------------------------------------------------------------------------
// Typen — gespiegelt von den Pydantic-Schemas im Backend
// ---------------------------------------------------------------------------

export type ApplicationStatus = 'pending' | 'approved' | 'rejected';
export type InstanceStatus = 'active' | 'suspended';

/** Spiegelt InstanceApplicationOut (User-Route). */
export interface InstanceApplication {
  id: string;
  applicant_user_id: string;
  hostname: string;
  purpose: string;
  expected_users: number;
  contact_email: string;
  notes: string | null;
  status: ApplicationStatus;
  reviewed_at: string | null;
  rejection_reason: string | null;
  approved_instance_id: string | null;
  created_at: string;
}

/** Spiegelt InstanceOut (User-Route, kein client_secret). */
export interface Instance {
  id: string;
  hostname: string;
  client_id: string;
  worker_id_chat: number;
  worker_id_voice: number;
  worker_id_media: number;
  status: InstanceStatus;
  registered_at: string;
  /** Geräteübergreifender Notification-Modus aus der Membership (account-basiert).
   *  (Das Backend führt zusätzlich ein dormantes ``user_label`` — der
   *  persönliche Server-Name wurde entfernt; den Namen bestimmt der Admin.) */
  notification_mode: 'all' | 'mentions' | 'none';
}

/** Spiegelt ApplicationOut (Admin-Route — trägt applicant_username). */
export interface AdminApplication {
  id: string;
  hostname: string;
  purpose: string;
  expected_users: number;
  contact_email: string;
  notes: string | null;
  status: string;
  created_at: string;
  applicant_username: string;
}

/** Spiegelt ApprovalOut (EINMALIG — client_secret nur hier). */
export interface Approval {
  instance_id: string;
  hostname: string;
  client_id: string;
  client_secret: string;
  worker_id_chat: number;
  worker_id_voice: number;
  worker_id_media: number;
  owner_user_id: string;
  warning: string;
}

/** Spiegelt InstanceOut (Admin-Route — trägt registrar_username). */
export interface AdminInstance {
  id: string;
  hostname: string;
  client_id: string;
  worker_id_chat: number;
  worker_id_voice: number;
  worker_id_media: number;
  status: string;
  registered_at: string;
  registrar_username: string;
}

/** Spiegelt RotateSecretOut. */
export interface RotateSecretResult {
  instance_id: string;
  client_secret: string;
  warning: string;
}

/** Spiegelt BootstrapTokenOut — One-Time-Token für den Ein-Befehl-Installer. */
export interface BootstrapToken {
  token: string;
  expires_at: string;
  ttl_seconds: number;
}

// ---------------------------------------------------------------------------
// User-Endpoints (/me/*)
// ---------------------------------------------------------------------------

export const instancesApi = {
  /** Antrag auf Self-Host-Instanz einreichen. Es wird nur der Hostname erfasst —
   *  die Kontakt-E-Mail leitet das Backend aus dem eingeloggten User ab. */
  submitApplication(payload: { hostname: string }): Promise<InstanceApplication> {
    return cookieFetch<InstanceApplication>('/me/instance-applications', {
      method: 'POST',
      body: payload
    });
  },

  /** Eigene Anträge abrufen (optional nach Status gefiltert). */
  listMyApplications(
    status: 'all' | ApplicationStatus = 'all'
  ): Promise<InstanceApplication[]> {
    const qs = status !== 'all' ? `?status=${status}` : '';
    return cookieFetch<InstanceApplication[]>(`/me/instance-applications${qs}`);
  },

  /** Eigene registrierte Instanzen (kein client_secret). */
  listMyInstances(): Promise<Instance[]> {
    return cookieFetch<Instance[]>('/me/instances');
  },

  /**
   * Membership auf einer Self-Host-Instanz in der Cloud eintragen — macht den
   * per Einladung beigetretenen Server auch auf anderen Geräten (Browser)
   * sichtbar. Idempotent; vom Client NUR nach erfolgreichem Cert-Login
   * aufgerufen. Owner-Rolle wird nie herabgestuft.
   */
  joinInstanceMembership(instanceId: string): Promise<void> {
    return cookieFetch<void>(`/me/instances/${instanceId}/membership`, { method: 'POST' });
  },

  /**
   * Cloud-Membership wieder entfernen, wenn der User den Server entfernt
   * (austritt). 403 für den Owner (der bleibt Mitglied). Idempotent.
   */
  leaveInstanceMembership(instanceId: string): Promise<void> {
    return cookieFetch<void>(`/me/instances/${instanceId}/membership`, { method: 'DELETE' });
  },

  /**
   * Geräteübergreifenden Notification-Modus setzen, damit Stummschalten auf
   * allen Geräten gilt (nicht nur lokal). Das Backend akzeptiert weiterhin ein
   * dormantes ``label`` (persönlicher Server-Name entfernt) — der Client sendet
   * es nicht mehr.
   */
  updateInstancePreferences(
    instanceId: string,
    prefs: { notification_mode?: 'all' | 'mentions' | 'none' }
  ): Promise<void> {
    return cookieFetch<void>(`/me/instances/${instanceId}/preferences`, {
      method: 'PATCH',
      body: prefs
    });
  },

  /** One-Time-Bootstrap-Token für den Ein-Befehl-Installer minten. */
  mintBootstrapToken(instanceId: string): Promise<BootstrapToken> {
    return cookieFetch<BootstrapToken>(`/me/instances/${instanceId}/bootstrap-token`, {
      method: 'POST'
    });
  },

  /**
   * Eigene Instanz löschen (Soft-Delete, irreversibel). Der Hostname wird
   * wieder für Neuanträge frei; ein noch laufender Server landet auf der
   * Suspend-Liste und stellt den Betrieb ein.
   */
  deleteMyInstance(instanceId: string): Promise<void> {
    return cookieFetch<void>(`/me/instances/${instanceId}`, { method: 'DELETE' });
  },

  /**
   * Fertige `.env` (inkl. frisch erzeugtem client_secret) als Download-Blob.
   * POST, weil jeder Aufruf das Secret serverseitig rotiert — ein erneuter
   * Download entwertet das vorherige Secret. Secret wird NIE geloggt.
   */
  async downloadEnvFile(instanceId: string): Promise<void> {
    const endpoint = `${AUTH_BASE}/me/instances/${instanceId}/env-file`;
    let resp = await fetch(endpoint, { method: 'POST', credentials: 'include' });
    // Abgelaufener Cookie → renewen + einmal retry (s. cookieFetch).
    if (resp.status === 401 && (await renewSession())) {
      resp = await fetch(endpoint, { method: 'POST', credentials: 'include' });
    }
    if (!resp.ok) {
      const text = await resp.text();
      const data = safeParse(text);
      throw new ApiError(resp.status, data, extractDetail(data) ?? resp.statusText);
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    // Content-Disposition vom Server enthält den Dateinamen, aber wir
    // setzen einen Fallback für den Fall, dass der Browser ihn ignoriert.
    const cd = resp.headers.get('Content-Disposition') ?? '';
    const match = cd.match(/filename="([^"]+)"/);
    a.download = match?.[1] ?? `pulse-instance-${instanceId}.env`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // a.click() stößt den Download nur an (asynchron). Würde der Object-URL hier
    // SYNCHRON revoked, kann der Browser den Blob noch nicht geholt haben → leere/
    // fehlgeschlagene .env-Datei (die das client_secret trägt → Operator müsste
    // rotate-secret erneut aufrufen und ein neues Geheimnis exponieren). Daher
    // verzögert freigeben — genug Zeit für den Download-Fetch, dennoch bounded.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
};

// ---------------------------------------------------------------------------
// Admin-Endpoints (/admin/*)
// ---------------------------------------------------------------------------

export const adminInstancesApi = {
  /** Anträge abrufen, gefiltert nach Status. */
  listApplications(
    status: 'pending' | 'approved' | 'rejected' = 'pending'
  ): Promise<AdminApplication[]> {
    return cookieFetch<AdminApplication[]>(`/admin/instance-applications?status=${status}`);
  },

  /** Antrag genehmigen — gibt client_secret EINMALIG zurück. */
  approveApplication(appId: string): Promise<Approval> {
    return cookieFetch<Approval>(`/admin/instance-applications/${appId}/approve`, {
      method: 'POST'
    });
  },

  /** Antrag ablehnen. */
  rejectApplication(appId: string, rejection_reason: string): Promise<void> {
    return cookieFetch<void>(`/admin/instance-applications/${appId}/reject`, {
      method: 'POST',
      body: { rejection_reason }
    });
  },

  /** Registrierte Instanzen auflisten. */
  listInstances(status: 'all' | 'active' | 'suspended' = 'all'): Promise<AdminInstance[]> {
    return cookieFetch<AdminInstance[]>(`/admin/instances?status=${status}`);
  },

  /** Instanz suspendieren (soft-delete). */
  suspendInstance(instanceId: string, reason?: string): Promise<void> {
    const qs = reason ? `?reason=${encodeURIComponent(reason)}` : '';
    return cookieFetch<void>(`/admin/instances/${instanceId}${qs}`, { method: 'DELETE' });
  },

  /** Instanz entsperren. */
  unsuspendInstance(instanceId: string): Promise<void> {
    return cookieFetch<void>(`/admin/instances/${instanceId}/unsuspend`, { method: 'POST' });
  },

  /** Secret rotieren — gibt client_secret EINMALIG zurück. */
  rotateSecret(instanceId: string): Promise<RotateSecretResult> {
    return cookieFetch<RotateSecretResult>(`/admin/instances/${instanceId}/rotate-secret`, {
      method: 'POST'
    });
  }
};
