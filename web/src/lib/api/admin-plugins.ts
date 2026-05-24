/**
 * Admin Plugin-Allowlist API-Client (Bootstrap-Admin only, `is_admin=true`).
 *
 * Spiegelt `services/chat-gateway/src/dcc_chat_gateway/routes/admin_plugins.py`:
 *
 *  * `GET    /api/chat/admin/plugins` — Discovery ∪ Allowlist.
 *  * `PUT    /api/chat/admin/plugins/{name}` — In Allowlist eintragen
 *    (idempotent). 404 wenn `name` nicht in der Discovery existiert.
 *  * `DELETE /api/chat/admin/plugins/{name}` — Aus Allowlist entfernen
 *    + alle `guild_plugins`-Toggles cascade-löschen. `hello` → 409.
 *
 * Allowlist-Mutationen brauchen einen Service-Restart, bevor sie sich
 * im Loader/Op-Gate auswirken (siehe Backend-Doku). Das UI zeigt
 * deshalb nach jedem PUT/DELETE einen Hinweis "Wirkt erst nach Restart".
 */
import { request } from './client';

export type AdminPluginEntry = {
  plugin_name: string;
  in_allowlist: boolean;
  in_discovery: boolean;
  version: string | null;
  description: string | null;
};

export type AdminPluginPutResult = {
  plugin_name: string;
  in_allowlist: boolean;
  requires_restart: boolean;
};

export const adminPluginsApi = {
  list(): Promise<AdminPluginEntry[]> {
    return request<AdminPluginEntry[]>('/admin/plugins', { endpoint: 'chat' });
  },
  allow(name: string): Promise<AdminPluginPutResult> {
    return request<AdminPluginPutResult>(`/admin/plugins/${name}`, {
      method: 'PUT',
      endpoint: 'chat'
    });
  },
  disallow(name: string): Promise<void> {
    return request<void>(`/admin/plugins/${name}`, {
      method: 'DELETE',
      endpoint: 'chat'
    });
  }
};
