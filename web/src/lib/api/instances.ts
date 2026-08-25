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

// 'closed' = Instanz vom Owner gelöscht → Antrag ist Historie (kein roter
// Punkt, kein Listeneintrag mehr — siehe routes_instance_delete.py).
// 'revoked' = App-Host-Freischaltung vom Admin zurückgenommen (nur origin
// 'app_host' — Historie, der User darf neu beantragen).
export type ApplicationStatus = 'pending' | 'approved' | 'rejected' | 'closed' | 'revoked';
/** Antragsart im vereinten Antragssystem: VPS mit eigener Domain oder
 *  App-Hosting von zuhause (Server-App, kein Hostname). */
export type ApplicationOrigin = 'vps' | 'app_host';
/** Ergebnis des beratenden Anschluss-Checks (lib/hosting/connectivityCheck). */
export type NetworkCheck = 'ok' | 'cgnat' | 'symmetric' | 'blocked' | 'unknown';
type InstanceStatus = 'active' | 'suspended';

/** Spiegelt InstanceApplicationOut (User-Route). */
export interface InstanceApplication {
  id: string;
  applicant_user_id: string;
  origin: ApplicationOrigin;
  hostname: string;
  purpose: string;
  expected_users: number;
  contact_email: string;
  notes: string | null;
  network_check: NetworkCheck | null;
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
  /** vps = klassischer Self-Host (erscheint in "Meine Instanzen"),
   *  app_host = Ein-Knopf-Container aus der App (nur App-Hosting-Karte). */
  origin: 'vps' | 'app_host';
  registered_at: string;
  /** Geräteübergreifender Notification-Modus aus der Membership (account-basiert).
   *  (Das Backend führt zusätzlich ein dormantes ``user_label`` — der
   *  persönliche Server-Name wurde entfernt; den Namen bestimmt der Admin.) */
  notification_mode: 'all' | 'mentions' | 'none';
}

/** Spiegelt ApplicationOut (Admin-Route — trägt applicant_username). */
export interface AdminApplication {
  id: string;
  applicant_user_id: string;
  origin: ApplicationOrigin;
  hostname: string;
  purpose: string;
  expected_users: number;
  contact_email: string;
  notes: string | null;
  network_check: NetworkCheck | null;
  /** Bei genehmigten app_host-Anträgen die angelegte Instanz — der „Aktiv"-Tab
   *  mappt darüber Instanz → Antrag (Revoke braucht die Antrags-ID). */
  approved_instance_id: string | null;
  status: string;
  created_at: string;
  applicant_username: string;
}

/** Spiegelt AppHostApprovalOut — Approve-Antwort für origin 'app_host'
 *  (kein client_secret; Pairing kommt später über den Bootstrap-Token). */
export interface AppHostApproval {
  id: string;
  user_id: string;
  self_host_enabled: boolean;
  /** Auto-provisionierte Relay-Instanz; null, wenn der User schon eine hatte. */
  instance_id: string | null;
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
  origin: 'vps' | 'app_host';
}

/** Spiegelt RotateSecretOut. */
export interface RotateSecretResult {
  instance_id: string;
  client_secret: string;
  warning: string;
}

/** Ein Glied der Kette (spiegelt SchrittAus in routes_selfhost_diagnose.py).
 *
 *  `titel`, `was_ist` und `was_tun` kommen FERTIG vom Server
 *  (`dcc_auth/diagnose_texte.py`) und werden hier nur noch angezeigt. Der
 *  Grund steht dort: dieselben Sätze erscheinen im Installer-Terminal, und
 *  zwei Kataloge beschrieben denselben Zustand nach kurzer Zeit verschieden.
 *  `befund` bleibt der maschinenlesbare Schlüssel — für Tests und Protokolle. */
export interface DiagnoseSchritt {
  schritt: string;
  ok: boolean;
  befund: string;
  einzelheit: string | null;
  titel: string;
  was_ist: string;
  /** Leer, wenn der Schritt sitzt. */
  was_tun: string;
}

/** Spiegelt DiagnoseAus. `gesamt` ist 'ok' oder der Name des ERSTEN Schritts,
 *  der nicht sass — nicht des letzten: alles danach ist Folge, nicht Ursache. */
export interface DiagnoseErgebnis {
  hostname: string;
  gesamt: string;
  schritte: DiagnoseSchritt[];
  /** Glieder, die wegen eines früheren Fehlschlags gar nicht geprüft wurden.
   *  Müssen sichtbar bleiben — sonst liest sich eine abgebrochene Kette wie
   *  eine vollständige. */
  nicht_geprueft: string[];
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
  /** Antrag auf Hosting-Freischaltung einreichen (vereintes Antragssystem).
   *  VPS: hostname Pflicht. App-Host: kein Hostname, optional das Ergebnis des
   *  beratenden Anschluss-Checks. Die Kontakt-E-Mail leitet das Backend aus
   *  dem eingeloggten User ab. */
  submitApplication(payload: {
    origin?: ApplicationOrigin;
    hostname?: string;
    purpose?: 'privat' | 'verein' | 'firma' | 'sonst';
    notes?: string | null;
    network_check?: NetworkCheck | null;
  }): Promise<InstanceApplication> {
    return cookieFetch<InstanceApplication>('/me/instance-applications', {
      method: 'POST',
      body: payload
    });
  },

  /** Eigene Anträge abrufen (nach Status/Art gefiltert). Das Backend liefert
   *  ohne origin-Parameter nur VPS (Alt-Client-Kompatibilität) — deshalb hier
   *  IMMER explizit senden, Default 'all'. */
  listMyApplications(
    status: 'all' | ApplicationStatus = 'all',
    origin: 'all' | ApplicationOrigin = 'all'
  ): Promise<InstanceApplication[]> {
    const params = new URLSearchParams({ origin });
    if (status !== 'all') params.set('status', status);
    return cookieFetch<InstanceApplication[]>(`/me/instance-applications?${params}`);
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

  /** One-Time-Bootstrap-Token für den Ein-Befehl-Installer minten.
   *  `reset: true` = bewusster Recovery-Pfad nach eingelöstem Bootstrap
   *  (Gerätewechsel/Creds-Verlust) — das spätere Einlösen rotiert die
   *  Credentials, ein alter Server verliert sofort den Zugang. */
  mintBootstrapToken(instanceId: string, opts?: { reset?: boolean }): Promise<BootstrapToken> {
    return cookieFetch<BootstrapToken>(`/me/instances/${instanceId}/bootstrap-token`, {
      method: 'POST',
      body: opts?.reset ? { reset: true } : undefined
    });
  },

  /**
   * Erreichbarkeitsprüfung von aussen: die Cloud geht die ganze Kette ab
   * (DNS, TCP, Zertifikat, /health, Identität, CORS, WebSocket-Upgrade, UDP)
   * und benennt das Glied, das fehlt. Das ist das Einzige, was der Server über
   * sich selbst nicht sagen kann.
   *
   * Dauert bis zu 40 s (der Server deckelt), deshalb ein eigener Zeitrahmen im
   * Aufrufer statt eines Spinners ins Blaue.
   */
  diagnose(instanceId: string): Promise<DiagnoseErgebnis> {
    return cookieFetch<DiagnoseErgebnis>(`/selfhost/diagnose/${instanceId}`, {
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
   *
   * Der erste Download ist frei, jeder weitere braucht `reset: true` (sonst
   * 403). Das ist der bewusste Recovery-Pfad bei verlorener Datei; ein damit
   * bereits laufender Server verliert dabei seinen Zugang.
   */
  async downloadEnvFile(instanceId: string, opts?: { reset?: boolean }): Promise<void> {
    const endpoint = `${AUTH_BASE}/me/instances/${instanceId}/env-file`;
    const init: RequestInit = { method: 'POST', credentials: 'include' };
    // Ohne `reset` bleibt der Body leer — die Route nimmt beides an, und ein
    // leerer Aufruf soll die One-Shot-Sperre gar nicht erst anfassen können.
    if (opts?.reset) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify({ reset: true });
    }
    let resp = await fetch(endpoint, init);
    // Abgelaufener Cookie → renewen + einmal retry (s. cookieFetch).
    if (resp.status === 401 && (await renewSession())) {
      resp = await fetch(endpoint, init);
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
  /** Anträge abrufen, gefiltert nach Status und Art (beide Origins). */
  listApplications(
    status: 'pending' | 'approved' | 'rejected' | 'revoked' | 'closed' | 'all' = 'pending',
    origin: 'all' | ApplicationOrigin = 'all'
  ): Promise<AdminApplication[]> {
    return cookieFetch<AdminApplication[]>(
      `/admin/instance-applications?status=${status}&origin=${origin}`
    );
  },

  /** Antrag genehmigen. Antwort ist origin-abhängig (Union): VPS liefert die
   *  einmalig gezeigten Credentials, App-Host nur Flag + Instanz-ID. */
  approveApplication(appId: string): Promise<Approval | AppHostApproval> {
    return cookieFetch<Approval | AppHostApproval>(
      `/admin/instance-applications/${appId}/approve`,
      { method: 'POST' }
    );
  },

  /** Antrag ablehnen. */
  rejectApplication(appId: string, rejection_reason: string): Promise<void> {
    return cookieFetch<void>(`/admin/instance-applications/${appId}/reject`, {
      method: 'POST',
      body: { rejection_reason }
    });
  },

  /** Erteilte App-Host-Freischaltung zurücknehmen: Flag aus + App-Host-
   *  Instanzen des Users suspendiert (Kill-Switch stoppt einen laufenden
   *  Container). Läuft über den eigenständigen (nicht-deprecated) Pfad —
   *  einen vereinten Zwilling gibt es bewusst nicht. */
  revokeAppHostApplication(appId: string, reason?: string): Promise<void> {
    const q = reason ? `?reason=${encodeURIComponent(reason)}` : '';
    return cookieFetch<void>(`/admin/app-host-applications/${appId}/revoke${q}`, {
      method: 'POST'
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
