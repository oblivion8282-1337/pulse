/**
 * Multi-Server-Store — Phase 4.1 Foundation
 *
 * Verwaltet die Liste der bekannten Server-Instanzen. Session-Tokens
 * leben NICHT hier (XSS-Härtung) — siehe session_tokens.svelte.ts.
 *
 * localStorage-Key: pulse.servers (JSON-Array von ServerEntry[])
 *
 * TODO Phase 4.3: Unter Electron auf window.pulse.store umstellen,
 * sobald der Store-IPC das unterstützt (dann kein localStorage-Fallback
 * mehr nötig, da Electron-store 600er chmod macht).
 */

export type ServerEntry = {
  id: string;                 // lokale UUID v4 (kein Cloud-Tracking)
  hostname: string;           // z.B. "https://chat.firma.de" (lowercase, kein trailing slash)
  instance_id: string | null; // Snowflake der Instanz (NULL für Cloud)
  label: string;              // User-vergeben oder vom Server
  pairwise_sub: string | null;// Pro-Server-Pseudonym (NULL für Cloud — dort user_id direkt)
  isCloud: boolean;           // true für howispulse.com (Hard-Default)
  notification_mode: 'all' | 'mentions' | 'none';
  added_at: number;           // Date.now() ms
};

export const CLOUD_HOSTNAME = 'https://howispulse.com';
export const CLOUD_LABEL = 'Pulse Cloud';

const LS_KEY = 'pulse.servers';

/** Normalisiert einen Hostname: HTTPS-only, lowercase, kein trailing slash.
 *  http://-URLs werden auf https:// hochgestuft — verhindert, dass Session-Tokens
 *  im Klartext übertragen werden (z.B. via Deep-Link mit http://-Host-Parameter).
 */
function normalizeHostname(raw: string): string {
  const trimmed = raw.trim().toLowerCase().replace(/\/$/, '');
  if (trimmed.startsWith('http://')) {
    return `https://${trimmed.slice('http://'.length)}`;
  }
  if (!trimmed.startsWith('https://')) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback für ältere Envs (sollte in modernen Browsern nie greifen)
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function buildCloudEntry(): ServerEntry {
  return {
    id: generateId(),
    hostname: CLOUD_HOSTNAME,
    instance_id: null,
    label: CLOUD_LABEL,
    pairwise_sub: null,
    isCloud: true,
    notification_mode: 'mentions',
    added_at: Date.now(),
  };
}

function loadFromStorage(): ServerEntry[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    // Re-derive isCloud from hostname to prevent XSS-injected entries
    // from overriding the cloud flag with a crafted isCloud value.
    const normalized = parsed.map((entry: unknown) => {
      const e = entry as ServerEntry;
      return {
        ...e,
        isCloud: (e.hostname ?? '').toLowerCase() === CLOUD_HOSTNAME.toLowerCase(),
      };
    });
    return normalized;
  } catch {
    // Korruptes JSON → Auto-Migration übernimmt
    return null;
  }
}

function saveToStorage(entries: ServerEntry[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(entries));
  } catch {
    // QuotaExceededError o.Ä. — silent, Store-State bleibt in Memory konsistent
  }
}

class ServersStore {
  servers = $state<ServerEntry[]>([]);

  /** Optionaler Listener, der nach jeder Mutation feuert (E2E-Vault-Push).
   *  Wird via setChangeListener registriert, um Circular-Imports zu vermeiden
   *  (servers.svelte.ts importiert NICHT den Vault). */
  private _onChange: (() => void) | null = null;

  setChangeListener(fn: (() => void) | null): void {
    this._onChange = fn;
  }

  private _notifyChange(): void {
    this._onChange?.();
  }

  /**
   * Muss synchron vor dem ersten Store-Zugriff aufgerufen werden.
   * Auto-Migration: fehlt pulse.servers → Cloud-Eintrag anlegen.
   */
  init(): void {
    const stored = loadFromStorage();
    if (stored) {
      // Sicherstellen dass immer ein Cloud-Eintrag vorhanden ist
      const hasCloud = stored.some((s) => s.isCloud);
      if (!hasCloud) {
        const withCloud = [buildCloudEntry(), ...stored];
        this.servers = withCloud;
        saveToStorage(withCloud);
      } else {
        this.servers = stored;
      }
    } else {
      // Kein gespeicherter State → frischer Cloud-Eintrag (Auto-Migration)
      const initial = [buildCloudEntry()];
      this.servers = initial;
      saveToStorage(initial);
    }
  }

  add(
    hostname: string,
    label?: string,
    instance_id?: string,
    pairwise_sub?: string,
  ): ServerEntry {
    const normalized = normalizeHostname(hostname);
    const isCloud = normalized === CLOUD_HOSTNAME;
    const entry: ServerEntry = {
      id: generateId(),
      hostname: normalized,
      instance_id: instance_id ?? null,
      label: label ?? (isCloud ? CLOUD_LABEL : normalized),
      pairwise_sub: pairwise_sub ?? null,
      isCloud,
      notification_mode: 'mentions',
      added_at: Date.now(),
    };
    this.servers = [...this.servers, entry];
    saveToStorage(this.servers);
    this._notifyChange();
    return entry;
  }

  remove(serverId: string): void {
    const entry = this.servers.find((s) => s.id === serverId);
    if (!entry) return;
    if (entry.isCloud) {
      throw new Error('Cloud-Server cannot be removed');
    }
    this.servers = this.servers.filter((s) => s.id !== serverId);
    saveToStorage(this.servers);
    this._notifyChange();
  }

  /**
   * Entfernt alle Self-Host-Einträge und behält nur den Cloud-Server.
   * Genutzt vom Account-Switch-Cleanup (auth `_enforceDeviceOwner`), wenn ein
   * fremder Geräte-Besitzer am selben Rechner erkannt wird — schließt den
   * gerätelokalen `pulse.servers`-Leak.
   *
   * **`silent=true` ist beim Cleanup zwingend:** es unterdrückt den
   * Change-Listener, sonst liefe ein Server-Tresor-Push und überschriebe den
   * Tresor des Vorgängers mit der gerade geleerten Liste (Datenverlust).
   */
  keepOnlyCloud(silent = false): void {
    const cloudOnly = this.servers.filter((s) => s.isCloud);
    if (cloudOnly.length === this.servers.length) return; // bereits nur Cloud
    this.servers = cloudOnly;
    saveToStorage(this.servers);
    if (!silent) this._notifyChange();
  }

  update(serverId: string, patch: Partial<ServerEntry>): void {
    this.servers = this.servers.map((s) =>
      s.id === serverId ? { ...s, ...patch, id: s.id } : s,
    );
    saveToStorage(this.servers);
    this._notifyChange();
  }

  find(serverId: string): ServerEntry | undefined {
    return this.servers.find((s) => s.id === serverId);
  }

  /** Der Cloud-ServerEntry (Identitäts-/Social-Plane). Es gibt immer genau
   *  einen (init() garantiert ihn). Global-Friends Stufe 1: Freunde/DMs/
   *  Requests/Blocks/Presence sind cloud-only — die zugehörigen REST/WS-Calls
   *  müssen gegen DIESEN Server laufen, nicht gegen den aktiven (der ein
   *  Self-Host sein kann). */
  cloud(): ServerEntry | undefined {
    return this.servers.find((s) => s.isCloud);
  }

  /** Die lokale UUID des Cloud-Servers (für `request(..., { serverId })`-Routing
   *  und `gatewayPool.for(cloudServerId())`). */
  cloudId(): string | undefined {
    return this.cloud()?.id;
  }

  findByHostname(hostname: string): ServerEntry | undefined {
    const normalized = normalizeHostname(hostname);
    return this.servers.find((s) => s.hostname === normalized);
  }
}

export const serversStore = new ServersStore();
