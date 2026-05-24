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
 * Allowlist-Mutationen wirken seit dem Hot-Reload-Patch live im
 * laufenden chat-gateway — der PUT/DELETE-Handler aktualisiert den
 * Snapshot ``app.state.plugin_allowlist`` direkt + ruft den
 * Plugin-Loader. ``requires_restart`` bleibt im Response-Schema (heute
 * hardcoded ``false``) als Vorbereitung für Multi-Pod-Setups (Stufe B).
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
