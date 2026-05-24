/**
 * Frontend mirror of `plugins/tamagotchi/plugin.toml`. Browser bundles can't
 * read TOML, so each plugin re-exports its manifest as a typed default-export
 * here; the Pulse frontend loader picks it up via `import.meta.glob`. Keep
 * this in lockstep with the TOML — the backend uses the TOML, the frontend
 * uses this. CI in Schritt 6+ will enforce that they match.
 */
import type { PluginManifest } from '../../web/src/lib/plugins/manifest-types';

const manifest: PluginManifest = {
  name: 'tamagotchi',
  version: '0.1.0',
  api: '1',
  author: 'Pulse Maintainer',
  description: 'Virtuelles Haustier pro User — füttern, spielen, schlafen',
  // `scope.type` beschreibt den State, nicht die Aktivierung. State ist
  // per-User (ein Pet pro User, Cross-Device via Settings-Section).
  // Activation läuft pro Guild (MANAGE_GUILD-Toggle); siehe
  // docs/PLUGIN_MANIFEST.md "Aktivierungsmodell".
  scope: { type: 'per-user' },
  uses: {
    // Backend registriert vier ``tamagotchi:{feed,play,sleep,reset}``-
    // Incoming-Handler; Frontend registriert einen ``tamagotchi:ack``-
    // Handler. Alle fünf gehen durch dieselbe Registry → Permission-Gate
    // (Schritt 5) verlangt jeden in dieser Liste.
    ws_ops: [
      'tamagotchi:feed',
      'tamagotchi:play',
      'tamagotchi:sleep',
      'tamagotchi:reset',
      'tamagotchi:ack'
    ],
    ws_emit_ops: ['tamagotchi:ack'],
    channels: [],
    settings_sections: ['tamagotchi'],
    ui_slots: []
  },
  entrypoints: {
    backend: 'backend:register',
    frontend: 'frontend.ts'
  }
};

export default manifest;
