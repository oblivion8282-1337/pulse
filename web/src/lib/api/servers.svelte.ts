/**
 * Multi-Server-Store — Phase 4.1 Foundation
 *
 * Verwaltet die Liste der bekannten Server-Instanzen. Session-Tokens
 * leben NICHT hier (XSS-Härtung) — siehe session_tokens.svelte.ts.
 *
 * Speicher-Backend (Key `pulse.servers`, JSON-Array von ServerEntry[]):
 *  - **Electron-Desktop:** der chmod-600-Tresor (`window.pulse.store`,
 *    `desktop/electron/store.ts`) — die Liste (Hostnames + pairwise-Pseudonyme)
 *    liegt damit nicht mehr im Klartext-Profil. Gelesen wird synchron via
 *    `getAllSync()` (der Tresor ist beim Boot schon komplett im Speicher),
 *    geschrieben asynchron via `set()` (fire-and-forget). Beim ersten Start
 *    nach dem Update wird eine evtl. vorhandene localStorage-Liste in den
 *    Tresor migriert und der Klartext-Eintrag gelöscht (siehe `loadFromStorage`).
 *  - **Browser:** localStorage (kein Tresor vorhanden) — gleicher Key, gleiche Form.
 *
 * `init()` bleibt synchron, damit der Boot-Code (activeServer, gatewayPool …)
 * die Liste unverändert sofort vorfindet.
 */

import { isElectron } from '$lib/platform/runtime';
import { normalizeHostname } from '$lib/utils/hostname';
import { instancesApi } from '$lib/api/instances';
import type { PulseStoreApi } from '$lib/platform/pulse';

export type ServerEntry = {
  id: string;                 // lokale UUID v4 (kein Cloud-Tracking)
  hostname: string;           // z.B. "https://chat.firma.de" (lowercase, kein trailing slash)
  instance_id: string | null; // Snowflake der Instanz (NULL für Cloud)
  label: string;              // Cloud-Anzeigename (CLOUD_LABEL). Für Self-Hosts nur
                              // ein Default (= hostname) und nicht mehr angezeigt —
                              // den Namen bestimmt allein der Admin via server_name.
  server_name: string | null; // Vom Server-Admin gesetzter Instanz-Anzeigename (aus
                              // dem ready-Frame). NULL = keiner gesetzt → Fallback
                              // auf den Hostnamen.
  pairwise_sub: string | null;// Pro-Server-Pseudonym (NULL für Cloud — dort user_id direkt)
  isCloud: boolean;           // true für howispulse.com (Hard-Default)
  notification_mode: 'all' | 'mentions' | 'none';
  added_at: number;           // Date.now() ms
};

/**
 * Anzuzeigender Server-Name. Den Namen bestimmt allein der Server-Admin —
 * ein Nutzer kann einen Server, auf dem er ist, NICHT selbst umbenennen.
 * Vorrang:
 *  1. Cloud: der feste „Pulse Cloud"-Name (``label``).
 *  2. Self-Host: der vom Admin gesetzte Instanz-Name (``server_name``),
 *  3. sonst der Hostname (URL).
 */
export function serverDisplayName(entry: ServerEntry): string {
  if (entry.isCloud) return entry.label;
  return entry.server_name || entry.hostname;
}

export const CLOUD_HOSTNAME = 'https://howispulse.com';
export const CLOUD_LABEL = 'Pulse Cloud';

/** Key in beiden Backends identisch (Tresor wie localStorage). */
const STORAGE_KEY = 'pulse.servers';

/** Der abgesicherte Electron-Tresor — oder null im reinen Browser bzw. wenn ein
 *  älteres preload den synchronen Schnell-Lesezugriff (`getAllSync`) noch nicht
 *  kennt; dann fällt der Code bewusst auf localStorage zurück. */
function secureStore(): PulseStoreApi | null {
  if (typeof window === 'undefined' || !isElectron()) return null;
  const store = window.pulse?.store;
  if (!store || typeof store.getAllSync !== 'function') return null;
  return store;
}

function buildCloudEntry(): ServerEntry {
  return {
    id: crypto.randomUUID(),
    hostname: CLOUD_HOSTNAME,
    instance_id: null,
    label: CLOUD_LABEL,
    server_name: null,
    pairwise_sub: null,
    isCloud: true,
    notification_mode: 'mentions',
    added_at: Date.now(),
  };
}

/** Normalisiert ein rohes Array: isCloud wird IMMER aus dem Hostname neu
 *  abgeleitet, damit ein (XSS-)injizierter `isCloud`-Wert die Cloud-Flagge nicht
 *  fälschen kann. Gibt null zurück, wenn die Form unbrauchbar/leer ist. */
function normalizeEntries(parsed: unknown): ServerEntry[] | null {
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  return parsed.map((entry: unknown) => {
    const e = entry as ServerEntry;
    return {
      ...e,
      // Default für Alt-Einträge ohne das Feld (vor diesem Build gespeichert).
      server_name: e.server_name ?? null,
      isCloud: (e.hostname ?? '').toLowerCase() === CLOUD_HOSTNAME.toLowerCase(),
    };
  });
}

function loadFromLocalStorage(): ServerEntry[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalizeEntries(JSON.parse(raw));
  } catch {
    // Korruptes JSON → Auto-Migration übernimmt
    return null;
  }
}

function loadFromStorage(): ServerEntry[] | null {
  const store = secureStore();
  if (store) {
    // Desktop: zuerst aus dem Tresor lesen.
    try {
      const fromVault = normalizeEntries(store.getAllSync()?.[STORAGE_KEY]);
      if (fromVault) return fromVault;
    } catch {
      /* defekter sync-Read → unten ggf. Migration/Fallback */
    }
    // Tresor leer → evtl. Alt-Liste aus localStorage in den Tresor umziehen
    // und den Klartext-Eintrag danach löschen (einmalig nach dem Update).
    const legacy = loadFromLocalStorage();
    if (legacy) {
      saveToStorage(legacy);
      try {
        window.localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* egal — der Tresor ist jetzt die Quelle der Wahrheit */
      }
      return legacy;
    }
    return null;
  }
  // Browser: localStorage.
  return loadFromLocalStorage();
}

function saveToStorage(entries: ServerEntry[]): void {
  if (typeof window === 'undefined') return;
  const store = secureStore();
  if (store) {
    // Desktop: nur in den Tresor schreiben (kein Klartext-localStorage mehr).
    // Fire-and-forget — der In-Memory-State bleibt die Quelle der Wahrheit.
    // $state.snapshot entkoppelt den reaktiven Proxy: ein roher $state-Array
    // ist über die Electron-IPC nicht structured-clone-bar ("An object could
    // not be cloned") — der Browser-Pfad unten umgeht das via JSON.stringify.
    void store.set(STORAGE_KEY, $state.snapshot(entries));
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
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
      id: crypto.randomUUID(),
      hostname: normalized,
      instance_id: instance_id ?? null,
      label: label ?? (isCloud ? CLOUD_LABEL : normalized),
      server_name: null,
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
    // Den Notification-Modus eines Self-Hosts zusätzlich in die Cloud spiegeln,
    // damit Stummschalten geräteübergreifend gilt (nicht nur lokal). Der
    // Server-NAME wird bewusst NICHT mehr synchronisiert — ihn bestimmt allein
    // der Server-Admin (instance_name), nicht der einzelne Nutzer. Andere Felder
    // (pairwise_sub etc.) lösen keinen Sync aus.
    const entry = this.find(serverId);
    if (
      entry &&
      !entry.isCloud &&
      entry.instance_id &&
      'notification_mode' in patch &&
      patch.notification_mode
    ) {
      void instancesApi
        .updateInstancePreferences(entry.instance_id, {
          notification_mode: patch.notification_mode,
        })
        .catch(() => undefined);
    }
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

  /** Add-account-based Self-Host re-hydration: merged fehlende
   *  Backend-Memberships in die gerätelokale Liste. Additiv + idempotent —
   *  `keepOnlyCloud(true)` nach Logout löscht nur Self-Hosts; ohne diesen
   *  Re-Hydrate-Pfad wären sie nach Logout+Login weg, obwohl die Membership
   *  in `auth.user_instance_memberships` weiter existiert.
   *  Fire-and-forget: Fehler werden geschluckt, der nächste Login retry't. */
  async hydrateFromBackend(): Promise<void> {
    try {
      const instances = await instancesApi.listMyInstances();
      if (!instances || instances.length === 0) return;

      let mutated = false;
      for (const inst of instances) {
        const normalized = normalizeHostname(inst.hostname);
        // Per Snowflake ODER per Hostname matchen — Vorgänger-Einträge ohne
        // instance_id (z.B. legacy localStorage) leben nur am Hostname.
        const existing = this.servers.find(
          (s) => s.instance_id === inst.id || s.hostname === normalized,
        );

        if (existing) {
          // Bereits gelistet → den geräteübergreifenden Notification-Modus
          // (Cloud = Quelle der Wahrheit) nachziehen, falls er hier abweicht.
          // Der Name kommt NICHT von hier — den bestimmt der Server-Admin.
          //
          // Der Hostname sehr wohl: bei App-Host-Servern wechselt er vom
          // synthetischen Platzhalter auf die Relay-Subdomain, sobald das
          // Gerät gepaart ist. Ohne Nachziehen zeigt ein einmal gespeicherter
          // Eintrag für immer auf den toten Platzhalter-Host.
          const hostChanged = existing.instance_id === inst.id && existing.hostname !== normalized;
          if (hostChanged || existing.notification_mode !== inst.notification_mode) {
            this.servers = this.servers.map((s) =>
              s.id === existing.id
                ? {
                    ...s,
                    hostname: hostChanged ? normalized : s.hostname,
                    notification_mode: inst.notification_mode,
                  }
                : s,
            );
            mutated = true;
          }
          continue;
        }

        this.servers = [
          ...this.servers,
          {
            id: crypto.randomUUID(),
            hostname: normalized,
            instance_id: inst.id,
            label: inst.hostname, // Default; der Anzeigename kommt vom Server-Admin
            server_name: null, // kommt beim ersten Connect aus dem ready-Frame
            pairwise_sub: null, // wird beim ersten Connect via Cert-Login gesetzt
            isCloud: false,
            notification_mode: inst.notification_mode,
            added_at: Date.now(),
          },
        ];
        mutated = true;
      }

      if (mutated) {
        saveToStorage(this.servers);
        this._notifyChange();
      }
    } catch {
      // silent — nächster Login retry't
    }
  }
}

export const serversStore = new ServersStore();
