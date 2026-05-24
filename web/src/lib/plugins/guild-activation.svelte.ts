/**
 * Pro-Guild Plugin-Activation-State — Frontend-Spiegel der Backend-API
 * (`GET /api/chat/guilds/{id}/plugins`).
 *
 * Hintergrund
 * -----------
 * Seit dem Plugin-Admin-Aktivierungs-PR (siehe `docs/PLUGIN_ROADMAP.md`)
 * ist die Plugin-Aktivierung **kein User-Setting mehr**, sondern zwei
 * server-gepflegte Ebenen: Instanz-Allowlist (Bootstrap-Admin) + Pro-
 * Guild-Toggle (Guild-Admin mit `MANAGE_GUILD`). Das Frontend braucht
 * also einen reaktiven Cache pro Guild, der beim Guild-Switch (re)geladen
 * wird — sonst wüsste die UI nicht, welche Plugin-Widgets für die aktuelle
 * Guild gerendert werden dürfen.
 *
 * Modell
 * ------
 * `Map<guildId, Set<enabledPluginName>>` — pro Guild ein Snapshot der
 * aktivierten Plugins. `hello` ist instanzweit aktiv und wird vom Backend
 * immer mit `enabled=true` zurückgeliefert; wir tragen ihn deshalb auch
 * mit ein, sodass `isPluginEnabledForGuild(g, 'hello') === true` gilt.
 *
 * Live-Updates
 * ------------
 * Beim PUT auf `/guilds/{id}/plugins/{name}` bzw. DELETE auf
 * `/admin/plugins/{name}` pusht das Backend ein `guild_plugins_changed`-
 * Event auf `guild:events` (per-Op-Membership-Scoping greift, nur
 * Member kriegen es). Der WS-Handler in `lib/ws/handlers/guild.ts`
 * patcht den Cache via `setGuildPluginEnabled`, wenn der Slot schon
 * geladen ist; sonst no-op (der nächste `ensureLoaded` zieht den
 * vollständigen Stand). So sieht jeder Mitspieler live, wenn der
 * Guild-Admin ein Plugin an- oder abschaltet — ohne F5.
 *
 * DM-Kontext
 * ----------
 * `guildId === ''` (DMs/Friends) hat keine Plugins. Aufrufer prüfen
 * vorher; dieser Store akzeptiert leere IDs nicht und liefert `false`.
 */
import { guildPluginsApi } from '$lib/api/guild-plugins';

interface GuildPluginsState {
  /** Map<guildId, enabledNames>. SvelteKit ist im SPA-Modus, also nur Client-Side. */
  enabledByGuild: Record<string, Set<string>>;
  /** Inflight-Markierung, damit parallele `ensureLoaded`-Aufrufe nicht
   *  doppelt fetchen. Map<guildId, Promise<void>>. */
  loadingByGuild: Map<string, Promise<void>>;
}

// `$state` mit Object-Reassign (Svelte 5 deep-track wäre für ein Map
// nicht reaktiv genug — wir nutzen Record + Set und reassignen die
// Records bei jedem Update). Set selbst wird beim Refresh ersetzt.
const state = $state<GuildPluginsState>({
  enabledByGuild: {},
  loadingByGuild: new Map()
});

/** Lade die Plugin-Aktivierungen für eine Guild vom Backend.
 *
 *  Idempotent: wenn schon geladen, no-op. Wenn ein Fetch läuft, hängt
 *  sich der Aufruf an die gemeinsame Promise. Bei Fehler wird der
 *  Cache-Slot NICHT gesetzt, damit ein späterer Retry möglich bleibt. */
export async function ensureGuildPluginsLoaded(guildId: string): Promise<void> {
  if (!guildId) return;
  if (state.enabledByGuild[guildId]) return;
  const existing = state.loadingByGuild.get(guildId);
  if (existing) return existing;
  const p = (async () => {
    try {
      const rows = await guildPluginsApi.list(guildId);
      const enabled = new Set<string>();
      for (const r of rows) if (r.enabled) enabled.add(r.plugin_name);
      state.enabledByGuild = { ...state.enabledByGuild, [guildId]: enabled };
    } catch (err) {
      console.error(`[plugins] failed to load guild plugins for ${guildId}`, err);
    } finally {
      state.loadingByGuild.delete(guildId);
    }
  })();
  state.loadingByGuild.set(guildId, p);
  return p;
}

/** Force-refresh — nach einem Toggle ruft die UI das auf, damit die
 *  Server-Antwort den lokalen Cache aktualisiert. */
export async function refreshGuildPlugins(guildId: string): Promise<void> {
  if (!guildId) return;
  // Slot zurücksetzen, damit `ensureGuildPluginsLoaded` neu lädt.
  const copy = { ...state.enabledByGuild };
  delete copy[guildId];
  state.enabledByGuild = copy;
  await ensureGuildPluginsLoaded(guildId);
}

/** Lokaler Patch nach erfolgreichem Toggle (UI-seitig direkt nach dem
 *  PUT, damit das Widget sofort verschwindet/auftaucht). */
export function setGuildPluginEnabled(
  guildId: string,
  pluginName: string,
  enabled: boolean
): void {
  if (!guildId) return;
  const cur = state.enabledByGuild[guildId];
  const next = new Set(cur ?? []);
  if (enabled) next.add(pluginName);
  else next.delete(pluginName);
  state.enabledByGuild = { ...state.enabledByGuild, [guildId]: next };
}

/** Reaktiver Check fürs UI. `guildId === ''` (DM-Kontext) → immer false. */
export function isPluginEnabledForGuild(
  guildId: string,
  pluginName: string
): boolean {
  if (!guildId) return false;
  return state.enabledByGuild[guildId]?.has(pluginName) ?? false;
}

/** Vergiss den Cache (Sign-Out / Workspace-Wechsel). */
export function resetGuildPluginsCache(): void {
  state.enabledByGuild = {};
  state.loadingByGuild.clear();
}

/** Reaktiver Read-Only-Snapshot fürs UI (z.B. Slot-Konditionals). */
export const guildPluginActivation = {
  get enabledByGuild(): Readonly<Record<string, ReadonlySet<string>>> {
    return state.enabledByGuild;
  }
};
