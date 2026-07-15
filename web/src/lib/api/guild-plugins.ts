/**
 * Pro-Guild Plugin-Toggle API-Client.
 *
 * Spiegelt `services/chat-gateway/src/dcc_chat_gateway/routes/guild_plugins.py`:
 *
 *  * `GET    /api/chat/guilds/{guild_id}/plugins` — Liste `[{plugin_name, enabled}]`,
 *    Caller muss Guild-Mitglied sein (sonst 403).
 *  * `PUT    /api/chat/guilds/{guild_id}/plugins/{name}` — Body `{enabled}`,
 *    benötigt `MANAGE_GUILD` (Owner-Bypass). `hello` ist nicht togglebar → 409.
 *
 * Hello-Sonderfall: das Backend liefert `hello` immer als `enabled: true`
 * mit zurück. PUT auf `hello` → 409; das Frontend zeigt den Toggle deshalb
 * disabled mit Hinweis "Immer aktiv (System-Plugin)".
 */
import { request } from './client';

export type GuildPluginEntry = {
  plugin_name: string;
  enabled: boolean;
};

type GuildPluginTogglePayload = {
  enabled: boolean;
};

export const guildPluginsApi = {
  list(guildId: string): Promise<GuildPluginEntry[]> {
    return request<GuildPluginEntry[]>(`/guilds/${guildId}/plugins`, {
      endpoint: 'chat'
    });
  },
  toggle(
    guildId: string,
    name: string,
    enabled: boolean
  ): Promise<GuildPluginEntry> {
    return request<GuildPluginEntry>(`/guilds/${guildId}/plugins/${name}`, {
      method: 'PUT',
      endpoint: 'chat',
      body: { enabled } satisfies GuildPluginTogglePayload
    });
  }
};
