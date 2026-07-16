/**
 * Per-Server-Capabilities-Cache.
 *
 * Hält die server-weiten Permission-Flags (aktuell ``allow_guild_creation``,
 * ``allow_member_invites``) **pro Server-ID** — anders als der ``capabilities``-
 * Singleton, der nur den aktiven Server spiegelt. Die GuildRail braucht das,
 * um pro Server-Sektion ein „+" (Community erstellen) korrekt zu gaten: ohne
 * den Flag des jeweiligen Servers wüsste sie nur beim aktiven Server, ob
 * Erstellen erlaubt ist.
 *
 * Multi-server (wie ``serverGuilds``): wird **nicht** im Server-Switch-Reset
 * geleert, nur per ``forget(id)`` (Server-Remove) bzw. ``clear()`` (Sign-Out).
 *
 * Load-Modell: ``ensureLoaded(serverId)`` feuert einmal ``GET /capabilities``
 * gegen den Server und cached das Ergebnis. Fehler werden geschluckt (das „+"
 * bleibt dann für Nicht-Admins aus — Admin-Status gatet unabhängig davon).
 */

import { chatApi } from '$lib/api/chat';

type ServerCaps = {
  allowGuildCreation: boolean;
  allowMemberInvites: boolean;
  /** Upload-Fläche dieses Servers (Instanz-Policy, env-getrieben).
   * Die Cloud begrenzt sie auf das, was Hash-Matching sehen kann; Self-Hosts
   * melden die permissiven Werte. Muss **pro Server** gelesen werden — ein
   * Client hängt gleichzeitig an Cloud UND Self-Hosts, ein globaler Flag
   * würde die Cloud-Regel auf fremde Server durchschlagen lassen.
   * Reine UI-Hints; der jeweilige Server erzwingt dieselben Regeln selbst. */
  dmAttachmentsEnabled: boolean;
  dropboxEnabled: boolean;
  /** Erlaubte MIME-Präfixe für Anhänge; leer = unbeschränkt. */
  attachmentMimePrefixes: string[];
};

class ServerCapabilitiesStore {
  byServer = $state<Record<string, ServerCaps>>({});
  private loading: Record<string, boolean> = {};

  /** Capabilities eines Servers (oder undefined, solange nicht geladen). */
  get(serverId: string): ServerCaps | undefined {
    return this.byServer[serverId];
  }

  /** Best-effort REST-Fetch, dedupliziert pro Server-ID. Bereits geladene
   *  Server werden nicht erneut gefetched. */
  async ensureLoaded(serverId: string): Promise<void> {
    if (!serverId) return;
    if (this.byServer[serverId] || this.loading[serverId]) return;
    this.loading[serverId] = true;
    try {
      const c = await chatApi.getCapabilities({ serverId });
      this.byServer = {
        ...this.byServer,
        [serverId]: {
          allowGuildCreation: c.allow_guild_creation,
          allowMemberInvites: c.allow_member_invites,
          // ``?? true`` / ``?? []``: ältere Instanzen kennen die Felder nicht →
          // unbeschränkt, damit ein Update der Cloud keine fremden Server gatet.
          dmAttachmentsEnabled: c.dm_attachments_enabled ?? true,
          dropboxEnabled: c.dropbox_enabled ?? true,
          attachmentMimePrefixes: c.attachment_mime_prefixes ?? [],
        },
      };
    } catch {
      // Server temporär nicht erreichbar (z.B. Self-Host vor Re-Auth) — kein
      // Eintrag, ``get`` liefert undefined, das „+" bleibt für Nicht-Admins aus.
    } finally {
      this.loading[serverId] = false;
    }
  }

  /** Erzwungener Re-Fetch (z.B. nach ``permissions_updated`` auf einem Server). */
  async refresh(serverId: string): Promise<void> {
    delete this.byServer[serverId];
    this.loading[serverId] = false;
    await this.ensureLoaded(serverId);
  }

  /** Server wurde entfernt → Cache-Eintrag weg. */
  forget(serverId: string): void {
    if (!(serverId in this.byServer)) return;
    const next = { ...this.byServer };
    delete next[serverId];
    this.byServer = next;
    delete this.loading[serverId];
  }

  /** Sign-Out — alles weg. */
  clear(): void {
    this.byServer = {};
    this.loading = {};
  }
}

export const serverCapabilities = new ServerCapabilitiesStore();
