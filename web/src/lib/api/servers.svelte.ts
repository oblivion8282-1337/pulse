/**
 * Multi-Server-Store — Phase 4.1 Foundation
 *
 * Verwaltet die Liste der bekannten Server-Instanzen. Session-Tokens
 * leben NICHT hier (XSS-Härtung) — siehe session_tokens.svelte.ts.
 *
 * Speicher-Backend (Key `pulse.servers`, JSON-Array von ServerEntry[]):
 *  - **Electron-Desktop:** der chmod-600-Tresor (`window.pulse.store`,
 *    `desktop/electron/store.ts`) — die Liste (Hostnames und Kennungen)
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
  /** Hat sich hier je jemand erfolgreich angemeldet?
   *
   *  Ersetzt die frühere Prüfung `pairwise_sub !== null`. Das Pseudonym gab es
   *  nur, weil jeder Server eine eigene Kennung vergab; es fiel mit dem
   *  Ticket-Weg weg — die Aussage, die daran hing, aber nicht: Eine genehmigte,
   *  aber nie eingerichtete Instanz erklärt dem Nutzer den toten Status-Punkt.
   *
   *  `undefined` bei Einträgen aus früheren Fassungen: Die haben sich
   *  nachweislich schon angemeldet (sonst gäbe es sie nicht), deshalb zählt nur
   *  ein ausdrückliches `false` als „nie". */
  je_verbunden?: boolean;
  label: string;              // Cloud-Anzeigename (CLOUD_LABEL). Für Self-Hosts nur
                              // ein Default (= hostname) und nicht mehr angezeigt —
                              // den Namen bestimmt allein der Admin via server_name.
  server_name: string | null; // Vom Server-Admin gesetzter Instanz-Anzeigename (aus
                              // dem ready-Frame). NULL = keiner gesetzt → Fallback
                              // auf den Hostnamen.
  // Instanz-Herkunft aus GET /me/instances (hydrateFromBackend): 'app_host'
  // = Direct-only (kein Relay-Fallback, s. lib/direct/policy.ts), 'vps' =
  // klassischer Self-Host. null = unbekannt (Alt-Eintrag/Cloud) → wie vps.
  origin?: 'vps' | 'app_host' | null;
  isCloud: boolean;           // true für howispulse.com (Hard-Default)
  // Eigene Rolle auf DIESEM Server, aus GET /me/instances (die Cloud weiss aus
  // ``registered_instances.registered_by``, wem ein Server gehoert — und zwar
  // OHNE Verbindung zu ihm). Sie fuellt die Luecke, solange der Server selbst
  // nichts gemeldet hat: sein ``is_admin`` kommt nur aus dem ready-Rahmen, und
  // den gibt es nur ueber eine bestehende WebSocket, die die App allein zum
  // AKTIVEN Server aufbaut. Ohne dieses Feld sah ein Betreiber auf seinem
  // eigenen, gerade nicht aktiven Server keinen Weg, eine Community anzulegen
  // (2026-08-27). Auswertung: ``lib/servers/erstellrecht.ts``.
  // null = unbekannt (Alt-Eintrag oder Cloud).
  role?: 'owner' | 'member' | null;
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
      origin: e.origin ?? null,
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
  ): ServerEntry {
    const normalized = normalizeHostname(hostname);
    const isCloud = normalized === CLOUD_HOSTNAME;
    const entry: ServerEntry = {
      id: crypto.randomUUID(),
      hostname: normalized,
      instance_id: instance_id ?? null,
      // Ausdrücklich false: Der Eintrag entsteht VOR der ersten Anmeldung. Wird
      // sie nichts, bleibt er stehen und der Nutzer sieht in der Rail, warum
      // der Status-Punkt tot ist.
      je_verbunden: isCloud ? true : false,
      label: label ?? (isCloud ? CLOUD_LABEL : normalized),
      server_name: null,
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
    // (rein lokale Felder) lösen keinen Sync aus.
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
   *  Backend-Memberships in die gerätelokale Liste und GLEICHT bestehende
   *  Einträge an die Cloud an (hostname/instance_id/origin/Default-Label —
   *  die Cloud-Membership ist die Autorität). Entfernt nie — additiv + idempotent —
   *  `keepOnlyCloud(true)` nach Logout löscht nur Self-Hosts; ohne diesen
   *  Re-Hydrate-Pfad wären sie nach Logout+Login weg, obwohl die Membership
   *  in `auth.user_instance_memberships` weiter existiert.
   *  Fire-and-forget; ein FETCH-Fehler (Cloud kurz down, z.B. 30-s-Deploy-
   *  Fenster) wird mit Backoff wiederholt statt bis zum nächsten Login zu
   *  schweigen — sonst bleibt die Liste auf diesem Gerät leer/veraltet
   *  (Vorfall 2026-07-14). Merge-Fehler dagegen retry't erst der nächste
   *  Login (Daten-, kein Netzproblem). */
  async hydrateFromBackend(attempt = 0): Promise<void> {
    // Frischer Aufruf (Login/Session-Restore) ersetzt eine laufende
    // Retry-Kette — nie zwei parallele Ketten.
    if (this._hydrateRetryTimer !== null) {
      clearTimeout(this._hydrateRetryTimer);
      this._hydrateRetryTimer = null;
    }
    let instances;
    try {
      instances = await instancesApi.listMyInstances();
    } catch {
      const delay = HYDRATE_RETRY_DELAYS_MS[attempt];
      if (delay !== undefined) {
        this._hydrateRetryTimer = setTimeout(() => {
          this._hydrateRetryTimer = null;
          void this.hydrateFromBackend(attempt + 1);
        }, delay);
      }
      return;
    }
    try {
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
          // Umgekehrt die instance_id: gleicher Hostname, aber andere/fehlende
          // ID = der Betreiber hat die Instanz unter derselben Adresse NEU
          // registriert (Löschen + frisches Setup). Ohne Nachziehen bleibt die
          // ID der ALTEN (gelöschten) Instanz stehen — der Sweep gelöschter
          // Instanzen (deleted-instance-sweep.ts) entfernt dann einen LEBENDEN
          // Server, und falsch verdrahtete Einträge werden unsweepbar
          // (Vorfall 2026-07-14, pulse.unicutmedia.com).
          const idChanged = existing.hostname === normalized && existing.instance_id !== inst.id;
          if (
            hostChanged ||
            idChanged ||
            existing.notification_mode !== inst.notification_mode ||
            existing.origin !== inst.origin ||
            existing.role !== inst.role
          ) {
            this.servers = this.servers.map((s) =>
              s.id === existing.id
                ? {
                    ...s,
                    hostname: hostChanged ? normalized : s.hostname,
                    instance_id: idChanged ? inst.id : s.instance_id,
                    // Default-Label mitheilen: label war nie ein User-Wunsch,
                    // sondern der Hostname zum Add-Zeitpunkt. Nach einem
                    // Hostname-Wechsel bliebe sonst für immer das alte
                    // Platzhalter-/Relay-Label stehen. Custom-Labels
                    // (label ≠ hostname) bleiben unangetastet.
                    label: hostChanged && s.label === s.hostname ? normalized : s.label,
                    notification_mode: inst.notification_mode,
                    // Herkunft nachziehen (Direct-only-Weiche braucht sie;
                    // Alt-Einträge haben sie noch nicht).
                    origin: inst.origin,
                    // Rolle nachziehen: ein Besitzerwechsel (Owner-Transfer)
                    // aendert sie, und Alt-Eintraege haben sie noch gar nicht.
                    role: inst.role,
                  }
                : s,
            );
            mutated = true;
          }
          continue;
        }

        // Noch nicht versorgt = noch nicht eingerichtet: kein Eintrag in der
        // Leiste. Bis 2026-08-27 entstand er in der Sekunde der Freigabe, und
        // der Nutzer sah einen Server, den es nirgends gab — mit totem
        // Status-Punkt und einer Erklärung, die nur im Tooltip stand. Bis
        // dahin lebt die Instanz unter „Eigener Server", wo auch der Knopf
        // sitzt, mit dem man sie einrichtet.
        //
        // Nur der NEUE Eintrag hängt daran. Bestehende bleiben unangetastet:
        // dieser Store entfernt grundsätzlich nichts (der Sweep gelöschter
        // Instanzen ist der einzige Löschpfad und hängt an ganz anderen
        // Bedingungen) — und ein Löschen träfe sonst auch einen laufenden
        // Server, dessen Pairing die Cloud nicht kennt.
        //
        // Fehlt das Feld (ältere Cloud), gilt „nicht eingerichtet" NICHT: dann
        // wäre die Leiste auf einen Schlag leer, obwohl sich nichts geändert
        // hat. Deshalb `=== false` statt `!inst.set_up`.
        if (inst.set_up === false) continue;

        this.servers = [
          ...this.servers,
          {
            id: crypto.randomUUID(),
            hostname: normalized,
            instance_id: inst.id,
            label: inst.hostname, // Default; der Anzeigename kommt vom Server-Admin
            server_name: null, // kommt beim ersten Connect aus dem ready-Frame
            origin: inst.origin,
            isCloud: false,
            role: inst.role,
            notification_mode: inst.notification_mode,
            // Die Schleife hat nicht eingerichtete Instanzen oben übersprungen
            // (``inst.set_up === false``) — was hier ankommt, ist eingerichtet,
            // und die Cloud ist dafür die bessere Quelle als dieses Gerät. Ohne
            // die Zeile bliebe das Feld ``undefined``, und der Hinweis „nicht
            // eingerichtet" ginge für jeden auf einem zweiten Gerät
            // hinzugekommenen Server verloren.
            je_verbunden: true,
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
      // Merge-Fehler: silent — nächster Login retry't (kein Backoff, s.o.)
    }
  }

  private _hydrateRetryTimer: ReturnType<typeof setTimeout> | null = null;
}

/** Backoff-Stufen für den Listen-Abgleich; danach übernimmt der nächste Login. */
const HYDRATE_RETRY_DELAYS_MS = [10_000, 30_000, 90_000];

export const serversStore = new ServersStore();
