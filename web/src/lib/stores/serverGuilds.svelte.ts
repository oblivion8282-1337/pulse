/**
 * Multi-Server-Guild-Liste für die Sidebar (Variante B).
 *
 * Hält pro Server-ID die Liste der Gilden — anders als ``guildsStore``,
 * der nur die Gilden des aktiv-verbundenen Servers spiegelt. Die Sidebar
 * rendert alle Sektionen gleichzeitig, daher muss jeder Server eine eigene
 * Snapshot-Liste haben.
 *
 * Load-Modell:
 *  - Beim ersten ``ensureLoaded(serverId)`` ein ``GET /guilds`` gegen den
 *    spezifischen Server. Antwort landet im Cache.
 *  - Für den **aktiven** Server hält ``activeBridge`` den Cache mit dem
 *    Live-Snapshot aus ``guildsStore`` synchron (WS-Ready-Frame ist
 *    autoritativ, kein Doppel-Fetch).
 *  - Cache-Invalidation bei Server-Remove via ``forget(serverId)``.
 *  - Mention-/Unread-Indicators bleiben ServerScoped — Sidebar nutzt sie
 *    nur für den aktiven Server (für die anderen sind die Channel-Listen
 *    eh nicht geladen).
 */

import { chatApi } from '$lib/api/chat';
import { guilds as activeGuilds } from './guilds.svelte';
import type { Guild } from '$lib/api/types';

class ServerGuildsStore {
  byServer = $state<Record<string, Guild[]>>({});
  loading = $state<Record<string, boolean>>({});

  /** Snapshot der Gilden eines Servers. Leere Liste bei unbekannter ID. */
  get(serverId: string): Guild[] {
    return this.byServer[serverId] ?? [];
  }

  /** Best-effort REST-Fetch, dedupliziert pro Server-ID. Fehler werden
   *  geschluckt (Sidebar zeigt dann nur die anderen Sektionen). */
  async ensureLoaded(serverId: string): Promise<void> {
    if (this.loading[serverId]) return;
    if (this.byServer[serverId]) return; // schon da
    this.loading = { ...this.loading, [serverId]: true };
    try {
      const guilds = await chatApi.listGuilds({ serverId });
      this.byServer = { ...this.byServer, [serverId]: guilds };
    } catch {
      // Self-Host kann temporär nicht erreichbar sein (expired Token vor
      // dem Re-Auth). Bei Fail leeren Eintrag setzen, damit ein späterer
      // ``refresh()`` ihn überschreiben kann.
      this.byServer = { ...this.byServer, [serverId]: [] };
    } finally {
      this.loading = { ...this.loading, [serverId]: false };
    }
  }

  /** Erzwungener Re-Fetch (z.B. nach Cert-Re-Login auf einem Self-Host). */
  async refresh(serverId: string): Promise<void> {
    this.loading = { ...this.loading, [serverId]: true };
    try {
      const guilds = await chatApi.listGuilds({ serverId });
      this.byServer = { ...this.byServer, [serverId]: guilds };
    } catch {
      // Bei Fail bestehenden Cache nicht löschen.
    } finally {
      this.loading = { ...this.loading, [serverId]: false };
    }
  }

  /** Aktiver-Server-Bridge: kopiert ``guildsStore.list`` in den Cache,
   *  sodass die Sidebar dieselbe Quelle wie ChannelList / ChatView nutzt
   *  und WS-Lifecycle-Events (guild_created/updated/deleted) automatisch
   *  in die Sidebar durchschlagen. */
  syncActive(activeServerId: string): void {
    if (!activeServerId) return;
    this.byServer = { ...this.byServer, [activeServerId]: activeGuilds.list };
  }

  /** Setzt den Snapshot eines Servers direkt (vom Bridge-Effect benutzt:
   *  ``activeServerId``-Snapshot stammt vom WS-Ready-Frame). Identisch zu
   *  ``syncActive``, aber mit einer expliziten Liste — vermeidet einen
   *  Re-Read von ``guildsStore`` während eines Tracking-Microtasks. */
  setSnapshot(serverId: string, list: Guild[]): void {
    if (!serverId) return;
    // Skip wenn die Reference unverändert ist — vermeidet überflüssige
    // Subscriber-Updates (Sidebar-Rerender) auf jeder Mausbewegung.
    if (this.byServer[serverId] === list) return;
    this.byServer = { ...this.byServer, [serverId]: list };
  }

  /** Server wurde entfernt → Cache aufräumen. */
  forget(serverId: string): void {
    if (!(serverId in this.byServer)) return;
    const next = { ...this.byServer };
    delete next[serverId];
    this.byServer = next;
  }

  /** Sign-Out — alles weg. */
  clear(): void {
    this.byServer = {};
    this.loading = {};
  }
}

export const serverGuilds = new ServerGuildsStore();
