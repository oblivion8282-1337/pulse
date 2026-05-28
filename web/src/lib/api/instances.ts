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

// ---------------------------------------------------------------------------
// Typen — gespiegelt von den Pydantic-Schemas im Backend
// ---------------------------------------------------------------------------

export type ApplicationStatus = 'pending' | 'approved' | 'rejected';
export type InstanceStatus = 'active' | 'suspended';
export type ApplicationPurpose = 'privat' | 'verein' | 'firma' | 'sonst';

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

// ---------------------------------------------------------------------------
// Interner Fetch-Helfer (Cookie-Auth, kein Bearer)
// ---------------------------------------------------------------------------

async function cookieFetch<T>(
  path: string,
  opts: { method?: string; body?: unknown } = {}
): Promise<T> {
  const { method = 'GET', body } = opts;
  const init: RequestInit = {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const resp = await fetch(`${AUTH_BASE}${path}`, init);

  if (resp.status === 204) return undefined as T;
  const text = await resp.text();
  const data = text ? safeParse(text) : null;
  if (!resp.ok) {
    const detail = extractDetail(data);
    throw new ApiError(resp.status, data, detail ?? resp.statusText);
  }
  return data as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractDetail(data: unknown): string | null {
  if (data && typeof data === 'object' && 'detail' in (data as Record<string, unknown>)) {
    const d = (data as { detail: unknown }).detail;
    if (typeof d === 'string') return d;
  }
  return null;
}

// ---------------------------------------------------------------------------
// User-Endpoints (/me/*)
// ---------------------------------------------------------------------------

export const instancesApi = {
  /** Antrag auf Self-Host-Instanz einreichen. */
  submitApplication(payload: {
    hostname: string;
    purpose: ApplicationPurpose;
    expected_users: number;
    contact_email: string;
    notes?: string | null;
  }): Promise<InstanceApplication> {
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
   * Docker-Compose-Snippet als Download-Blob.
   * Gibt die Response direkt zurück — Aufrufer triggert Download via URL.
   */
  async downloadComposeSnippet(instanceId: string): Promise<void> {
    const resp = await fetch(`${AUTH_BASE}/me/instances/${instanceId}/docker-compose-snippet`, {
      credentials: 'include'
    });
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
    URL.revokeObjectURL(url);
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
