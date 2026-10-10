import { strict as assert } from 'node:assert';
import { test } from 'node:test';

// Bughunt 2026-10-11, K1 — gegen das ECHTE `@capacitor/core`.
//
// `nativerSprachwegDa()` (platform/iosSprache.ts) fragte bis dahin
// `Capacitor.Plugins.SprachePlugin !== undefined`. Dasselbe Modul ruft beim
// Import `registerPlugin('SprachePlugin')` — und das schreibt den Eintrag
// selbst hinein. Auf jedem App-Bau ohne das Plugin war die Weiche damit wahr,
// und der Beitritt lief in `UNIMPLEMENTED`, ohne Rueckfall auf den Web-Weg.
//
// Die Weiche selbst laesst sich hier nicht laden (sie importiert ueber
// `./runtime` ohne Endung, s. CLAUDE.md). Geprueft wird deshalb die Annahme,
// auf der sie steht: `isPluginAvailable` antwortet nach der Kopfzeile der
// Huelle, nicht nach `registerPlugin`.

test('K1: registerPlugin fuellt Plugins — isPluginAvailable fragt die Huelle', async () => {
  const g = globalThis as Record<string, unknown>;
  // Eine iOS-Huelle, wie sie eine aeltere App ausliefert: Kopfzeilen fuer
  // andere Plugins, keine fuer `SprachePlugin`.
  g.webkit = { messageHandlers: { bridge: { postMessage() {} } } };
  g.Capacitor = { PluginHeaders: [{ name: 'AudioSessionPlugin', methods: [] }] };
  const { Capacitor, registerPlugin } = await import('@capacitor/core');
  registerPlugin('SprachePlugin');

  const plugins = (Capacitor as unknown as { Plugins: Record<string, unknown> }).Plugins;
  assert.equal(Capacitor.getPlatform(), 'ios');
  // Genau das war die alte Pruefung — und sie ist hier schon wahr.
  assert.notEqual(plugins.SprachePlugin, undefined);
  assert.equal(Capacitor.isPluginAvailable('SprachePlugin'), false);

  // Die neue Huelle spielt die Kopfzeile ein — erst dann ist es da.
  (g.Capacitor as { PluginHeaders: { name: string; methods: [] }[] }).PluginHeaders.push({
    name: 'SprachePlugin',
    methods: []
  });
  assert.equal(Capacitor.isPluginAvailable('SprachePlugin'), true);
});
