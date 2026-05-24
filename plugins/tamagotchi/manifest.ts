/**
 * Frontend mirror of `plugins/tamagotchi/plugin.toml`. Browser bundles can't
 * read TOML, so each plugin re-exports its manifest as a typed default-export
 * here; the Pulse frontend loader picks it up via `import.meta.glob`. Keep
 * this in lockstep with the TOML — the backend uses the TOML, the frontend
 * uses this.
 */
import type { PluginManifest } from '../../web/src/lib/plugins/manifest-types';

const manifest: PluginManifest = {
  name: 'tamagotchi',
  version: '0.2.0',
  api: '1',
  author: 'Pulse Maintainer',
  description: 'Virtuelles Server-Haustier — alle Mitglieder füttern es gemeinsam',
  // PR3: State-Scope ist per-guild — ein Pet pro Server, geteilt zwischen
  // allen Mitgliedern. Activation läuft ebenfalls pro Guild
  // (MANAGE_GUILD-Toggle). Siehe docs/PLUGIN_MANIFEST.md "Aktivierungs- vs
  // State-Scope".
  scope: { type: 'per-guild' },
  uses: {
    // Backend registriert vier ``tamagotchi:{feed,play,sleep,reset}``-
    // Incoming-Handler; Frontend registriert einen
    // ``tamagotchi:state_update``-Handler für die Server-Broadcasts.
    // Alle fünf gehen durch dieselbe Registry → Permission-Gate verlangt
    // jeden in dieser Liste.
    ws_ops: [
      'tamagotchi:feed',
      'tamagotchi:play',
      'tamagotchi:sleep',
      'tamagotchi:reset',
      'tamagotchi:state_update'
    ],
    ws_emit_ops: ['tamagotchi:state_update'],
    // Pub/Sub-Channel für Cross-Pod-Broadcasts. Backend-Manifest deklariert
    // ihn; das Frontend hat keinen direkten Redis-Zugriff (rein
    // dokumentarisch hier, kein Wirkmechanismus).
    channels: ['plugin:tamagotchi:events'],
    // Keine Settings-Section mehr seit PR3 — State lebt server-seitig.
    settings_sections: [],
    ui_slots: []
  },
  entrypoints: {
    backend: 'backend:register',
    frontend: 'frontend.ts'
  }
};

export default manifest;
