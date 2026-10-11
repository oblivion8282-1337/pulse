import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Die Weiche zum nativen Sprachweg (platform/iosSpracheWeiche.ts) — gegen das
// ECHTE `@capacitor/core`, mit nachgebauten Kopfzeilen der Huelle.
//
// Bughunt 2026-10-11, K1: `nativerSprachwegDa()` fragte bis dahin
// `Capacitor.Plugins.SprachePlugin !== undefined`. `iosSprache.ts` ruft beim
// Import `registerPlugin('SprachePlugin')` — und das schreibt den Eintrag
// selbst hinein. Auf jedem App-Bau ohne das Plugin war die Weiche damit wahr.
//
// Am selben Tag die zweite Haelfte: das Plugin da, aber mit fuenf statt elf
// Methoden (Telefon des Eigentuemers). Seither muss der Bau ALLE Methoden aus
// `SPRACHE_METHODEN` kennen.
//
// Die Weiche selbst laedt hier GANZ (ihre Importe tragen die `.ts`-Endung);
// bis zum 2026-10-11 ging das nicht, und geprueft wurde nur die Annahme, auf
// der sie steht (erster Test).

type Kopf = { name: string; methods: { name: string; rtype: string | null }[] };
const g = globalThis as Record<string, unknown>;

// Eine iOS-Huelle, wie sie eine aeltere App ausliefert: Kopfzeilen fuer
// andere Plugins, keine fuer `SprachePlugin`.
g.webkit = { messageHandlers: { bridge: { postMessage() {} } } };
g.Capacitor = { PluginHeaders: [{ name: 'AudioSessionPlugin', methods: [] }] };
// Fuer `isCapacitorIOS()` (platform/runtime.ts): Fenster und iPhone-Kennung.
g.window = globalThis;
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)', maxTouchPoints: 5 },
  configurable: true
});

/** Ein Kopf, wie ihn Capacitors `JSExport.createPluginHeader` baut: fuenf
 *  Methoden gibt der Kern jedem Plugin bei, dahinter die `pluginMethods`. */
function kopfWieDieHuelle(name: string, methoden: string[]): Kopf {
  const mitPromise = ['removeAllListeners', 'checkPermissions', 'requestPermissions', ...methoden];
  return {
    name,
    methods: [
      { name: 'addListener', rtype: null },
      { name: 'removeListener', rtype: null },
      ...mitPromise.map((n) => ({ name: n, rtype: 'promise' }))
    ]
  };
}

function sprachKopfSetzen(kopf: Kopf | null): void {
  const liste = (g.Capacitor as { PluginHeaders: Kopf[] }).PluginHeaders;
  const rest = liste.filter((k) => k.name !== 'SprachePlugin');
  liste.splice(0, liste.length, ...rest, ...(kopf ? [kopf] : []));
}

test('K1: registerPlugin fuellt Plugins — isPluginAvailable fragt die Huelle', async () => {
  const { Capacitor, registerPlugin } = await import('@capacitor/core');
  registerPlugin('SprachePlugin');

  const plugins = (Capacitor as unknown as { Plugins: Record<string, unknown> }).Plugins;
  assert.equal(Capacitor.getPlatform(), 'ios');
  // Genau das war die alte Pruefung — und sie ist hier schon wahr.
  assert.notEqual(plugins.SprachePlugin, undefined);
  assert.equal(Capacitor.isPluginAvailable('SprachePlugin'), false);

  // Die neue Huelle spielt die Kopfzeile ein — erst dann ist es da.
  sprachKopfSetzen({ name: 'SprachePlugin', methods: [] });
  assert.equal(Capacitor.isPluginAvailable('SprachePlugin'), true);
});

test('ohne SprachePlugin im Bau: Web-Weg, Grund kein-plugin', async () => {
  const { nativerSprachwegBefund } = await import('../src/lib/platform/iosSpracheWeiche.ts');
  sprachKopfSetzen(null);
  assert.deepEqual(nativerSprachwegBefund(), { nativ: false, grund: 'kein-plugin' });
});

test('Bau des Eigentuemer-Telefons (fuenf Methoden): Web-Weg, mit den fehlenden', async () => {
  const { nativerSprachwegBefund, nativerSprachwegDa } = await import(
    '../src/lib/platform/iosSpracheWeiche.ts'
  );
  // Stand 107ccd3f (2026-10-10) — so am 2026-10-11 auf dem Geraet.
  sprachKopfSetzen(
    kopfWieDieHuelle('SprachePlugin', ['beitreten', 'verlassen', 'mikrofon', 'ausgabe', 'zustand'])
  );
  // Gegenprobe: die Pruefung bis heute (nur das Plugin) haette hier JA gesagt.
  const { Capacitor } = await import('@capacitor/core');
  assert.equal(Capacitor.isPluginAvailable('SprachePlugin'), true);
  assert.equal(nativerSprachwegDa(), false);
  assert.deepEqual(nativerSprachwegBefund(), {
    nativ: false,
    grund: 'methoden-fehlen',
    fehlen: [
      'lautstaerken',
      'erzwungen',
      'taub',
      'kamera',
      'kameraSeite',
      'ansichtOeffnen',
      'ansichtSchliessen'
    ]
  });
});

test('Bau aus dem heutigen SprachePlugin.swift: nativer Weg', async () => {
  const { nativerSprachwegBefund } = await import('../src/lib/platform/iosSpracheWeiche.ts');
  // Die Methoden kommen aus der Swift-Quelle, nicht aus einer Abschrift: ein
  // Web-Ruf ohne Gegenstueck in der Huelle macht diesen Test rot, bevor ihn
  // ein Telefon zu spueren bekommt.
  const swift = readFileSync(
    new URL('../../mobile/ios/App/App/SprachePlugin.swift', import.meta.url),
    'utf8'
  );
  const methoden = [...swift.matchAll(/CAPPluginMethod\(name: "(\w+)"/g)].map((t) => t[1]);
  assert.ok(methoden.includes('beitreten'), 'Swift-Quelle nicht erkannt');
  sprachKopfSetzen(kopfWieDieHuelle('SprachePlugin', methoden));
  assert.deepEqual(nativerSprachwegBefund(), { nativ: true });
});

test('ausserhalb von iOS entscheidet die Plattform, nicht der Kopf', async () => {
  const { nativerSprachwegBefund } = await import('../src/lib/platform/iosSpracheWeiche.ts');
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (Linux; Android 15)', maxTouchPoints: 5 },
    configurable: true
  });
  assert.deepEqual(nativerSprachwegBefund(), { nativ: false, grund: 'kein-ios' });
});
