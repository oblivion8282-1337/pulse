/**
 * TypeScript types mirroring the Python `PluginManifest` model
 * (`services/chat-gateway/src/dcc_chat_gateway/plugins/manifest.py`).
 *
 * Spec: `docs/PLUGIN_MANIFEST.md`. The frontend loader does not parse TOML
 * directly — it reads pre-parsed manifests from each plugin's `manifest.ts`
 * (a tiny TypeScript module that re-exports the manifest as a typed object).
 * This keeps the Vite bundling story simple and avoids shipping a TOML parser
 * to the browser.
 */

/** Pulse Plugin-API major. Schritt 4 ships `"1"`. */
export const DEFAULT_PLUGIN_API = '1' as const;

export type ScopeType = 'per-user' | 'per-guild' | 'global';

export interface PluginScope {
  type: ScopeType;
}

export interface PluginUses {
  ws_ops: string[];
  ws_emit_ops: string[];
  channels: string[];
  settings_sections: string[];
  ui_slots: string[];
}

export interface PluginEntrypoints {
  /** Python entry — recorded on the frontend so the manifest stays a 1:1
   *  mirror of the TOML; unused by the frontend loader. */
  backend?: string;
  /** Path relative to the plugin dir; resolved by the frontend loader's
   *  `import.meta.glob` map. */
  frontend?: string;
}

export interface PluginManifest {
  name: string;
  version: string;
  api: string;
  author?: string;
  description?: string;
  scope: PluginScope;
  uses: PluginUses;
  entrypoints: PluginEntrypoints;
}

/** Default-export contract of a plugin's frontend entry module. */
export type PluginRegisterFn = () => void | Promise<void>;

/** Optional deactivate-hook a plugin can export alongside `register`. */
export type PluginDeactivateFn = () => void | Promise<void>;

/** Shape of a frontend plugin entry module. The default export is the
 *  required register-function; `deactivate` is optional and lets the plugin
 *  do its own cleanup beyond the registry-tracked `unregister*` calls. */
export interface PluginEntryModule {
  default: PluginRegisterFn;
  deactivate?: PluginDeactivateFn;
}
