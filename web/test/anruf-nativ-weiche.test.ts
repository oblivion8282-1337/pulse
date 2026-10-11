import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Die Weiche zum nativen Anrufweg (platform/anrufNativWeiche.ts, Etappe 4) —
// gegen das ECHTE `@capacitor/core`, mit nachgebauten Kopfzeilen der Hülle,
// wie `ios-sprache-weiche.test.ts`.
//
// Die teuerste Antwort ist ein falsches Ja: eine Oberfläche, die gegen einen
// älteren App-Bau den nativen Anruf fährt, ruft Methoden, die die Hülle
// nicht hat — der Anruf sähe verbunden aus und wäre stumm. Deshalb kommen
// die Methoden des heutigen Baus aus den Swift-Quellen, nicht aus einer
// Abschrift.

type Kopf = { name: string; methods: { name: string; rtype: string | null }[] };
const g = globalThis as Record<string, unknown>;

g.webkit = { messageHandlers: { bridge: { postMessage() {} } } };
g.Capacitor = { PluginHeaders: [] as Kopf[] };
g.window = globalThis;
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)', maxTouchPoints: 5 },
  configurable: true
});

function kopf(name: string, methoden: string[]): Kopf {
  return {
    name,
    methods: [
      { name: 'addListener', rtype: null },
      { name: 'removeListener', rtype: null },
      ...['removeAllListeners', ...methoden].map((n) => ({ name: n, rtype: 'promise' }))
    ]
  };
}

function köpfeSetzen(...k: Kopf[]): void {
  const liste = (g.Capacitor as { PluginHeaders: Kopf[] }).PluginHeaders;
  liste.splice(0, liste.length, ...k);
}

function swiftMethoden(...dateien: string[]): string[] {
  return dateien.flatMap((datei) => {
    const quelle = readFileSync(new URL(`../../mobile/ios/App/App/${datei}`, import.meta.url), 'utf8');
    return [...quelle.matchAll(/CAPPluginMethod\(name: "(\w+)"/g)].map((t) => t[1]);
  });
}

const sprache = () => kopf('SprachePlugin', swiftMethoden('SprachePlugin.swift'));
const anrufHeute = () => kopf('Anruf', swiftMethoden('AnrufPlugin.swift'));

test('heutiger Bau (Sprache + Anruf aus den Swift-Quellen): nativer Anrufweg', async () => {
  const { nativerAnrufwegDa } = await import('../src/lib/platform/anrufNativWeiche.ts');
  const anruf = anrufHeute();
  assert.ok(anruf.methods.some((m) => m.name === 'raumBeitreten'), 'Swift-Quelle nicht erkannt');
  köpfeSetzen(sprache(), anruf);
  assert.equal(nativerAnrufwegDa(), true);
});

test('Bau mit dem alten Anruf-Plugin (ankommen, beenden, voipToken): Web-Weg', async () => {
  const { nativerAnrufwegDa } = await import('../src/lib/platform/anrufNativWeiche.ts');
  köpfeSetzen(sprache(), kopf('Anruf', ['ankommen', 'beenden', 'voipToken']));
  assert.equal(nativerAnrufwegDa(), false);
});

test('ohne nativen Sprachweg kein nativer Anruf — sie teilen sich die Session', async () => {
  const { nativerAnrufwegDa } = await import('../src/lib/platform/anrufNativWeiche.ts');
  köpfeSetzen(anrufHeute());
  assert.equal(nativerAnrufwegDa(), false);
});

test('jede Methode, die das Web ruft, steht in pluginMethods der Hülle', async () => {
  const { ANRUF_RAUM_METHODEN } = await import('../src/lib/platform/anrufNativ.ts');
  const inDerHülle = new Set(swiftMethoden('AnrufPlugin.swift'));
  const fehlen = ANRUF_RAUM_METHODEN.filter((m) => !inDerHülle.has(m));
  assert.deepEqual(fehlen, []);
});
