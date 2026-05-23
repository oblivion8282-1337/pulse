/**
 * Frontend mirror of `plugins/hello/plugin.toml`. Browser bundles can't read
 * TOML, so each plugin re-exports its manifest as a typed default-export
 * here; the Pulse frontend loader picks it up via `import.meta.glob`. Keep
 * this in lockstep with the TOML file — the backend uses the TOML, the
 * frontend uses this. CI in Schritt 6 will enforce that they match.
 */
import type { PluginManifest } from '../../web/src/lib/plugins/manifest-types';

const manifest: PluginManifest = {
  name: 'hello',
  version: '0.1.0',
  api: '1',
  author: 'Pulse Maintainer',
  description: 'Ping/Pong-Demo, beweist dass der Plugin-Loader läuft',
  scope: { type: 'global' },
  uses: {
    ws_ops: ['hello:ping'],
    ws_emit_ops: ['hello:pong'],
    channels: [],
    settings_sections: [],
    ui_slots: []
  },
  entrypoints: {
    backend: 'backend:register',
    frontend: 'frontend.ts'
  }
};

export default manifest;
