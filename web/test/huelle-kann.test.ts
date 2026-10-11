import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pluginBefund } from '../src/lib/platform/huellenKoepfe.ts';

// Kennt der installierte App-Bau ein Plugin und jede Methode daran?
// (platform/huellenKoepfe.ts + huelleKann.ts)

const kopf = (name: string, ...methoden: string[]) => ({
  name,
  methods: methoden.map((m) => ({ name: m, rtype: 'promise' }))
});

test('Plugin fehlt im Bau: kein-plugin', () => {
  assert.deepEqual(pluginBefund([kopf('Anderes', 'x')], 'Gesucht', ['x']), {
    da: false,
    grund: 'kein-plugin'
  });
  assert.deepEqual(pluginBefund(undefined, 'Gesucht', []), { da: false, grund: 'kein-plugin' });
});

test('Plugin da, Methoden fehlen: genau die fehlenden, in der Reihenfolge der Anfrage', () => {
  assert.deepEqual(pluginBefund([kopf('P', 'a', 'c')], 'P', ['d', 'a', 'b', 'c']), {
    da: false,
    grund: 'methoden-fehlen',
    fehlen: ['d', 'b']
  });
});

test('alle Methoden da: da', () => {
  assert.deepEqual(pluginBefund([kopf('P', 'a', 'b', 'extra')], 'P', ['a', 'b']), { da: true });
  // Ohne Anfrage zaehlt nur das Plugin.
  assert.deepEqual(pluginBefund([kopf('P')], 'P', []), { da: true });
});

test('kaputte Koepfe gelten als „kennt nichts", nicht als Fehler', () => {
  // Die Form kommt von aussen; lieber Rueckfallweg als halber Weg.
  assert.deepEqual(pluginBefund('quatsch', 'P', ['a']), { da: false, grund: 'kein-plugin' });
  assert.deepEqual(pluginBefund([null, { name: 'P' }], 'P', ['a']), {
    da: false,
    grund: 'methoden-fehlen',
    fehlen: ['a']
  });
  assert.deepEqual(pluginBefund([{ name: 'P', methods: 'a' }], 'P', ['a']), {
    da: false,
    grund: 'methoden-fehlen',
    fehlen: ['a']
  });
});

// Was ein fehlender Eintrag gegen das ECHTE `@capacitor/core` anrichtet — die
// Grundlage fuer den Kopfkommentar von `huelleKann.ts`. `nativePromise` steht
// hier fuer die Bruecke und antwortet nie: genau das tut die Huelle bei einer
// unbekannten Methode (`CapacitorBridge.handleJSCall`, „No method found").

const g = globalThis as Record<string, unknown>;
const anDieHuelle: string[] = [];
g.webkit = { messageHandlers: { bridge: { postMessage() {} } } };
g.Capacitor = {
  PluginHeaders: [kopf('Alt', 'beitreten', 'mikrofon')],
  nativePromise(plugin: string, methode: string) {
    anDieHuelle.push(`${plugin}.${methode}`);
    return new Promise(() => undefined);
  }
};

/** `true`, wenn `lauf` binnen `ms` noch nicht entschieden ist. */
async function haengt(lauf: Promise<unknown>, ms = 50): Promise<boolean> {
  const offen = Symbol('offen');
  const ergebnis = await Promise.race([
    lauf.then(
      () => 'erfuellt',
      () => 'abgelehnt'
    ),
    new Promise((r) => setTimeout(() => r(offen), ms))
  ]);
  return ergebnis === offen;
}

type AltesPlugin = {
  mikrofon(o: object): Promise<unknown>;
  taub(o: object): Promise<unknown>;
};

// Erst NACH dem Nachbau der Huelle laden (der Kern liest `window.Capacitor`
// beim Import), und einmal registrieren — wie in der App, mit dem Kopf schon
// da: `registerPlugin` liest ihn genau einmal. **Nie aus einer `async`-
// Funktion zurueckgeben:** `await` fragt den Proxy nach `then`, und der Kern
// beantwortet das als Plugin-Methode mit `UNIMPLEMENTED`.
const { registerPlugin } = await import('@capacitor/core');
const alt = registerPlugin<AltesPlugin>('Alt');

test('fehlende Methode ueber registerPlugin: sofort UNIMPLEMENTED, kein Ruf an die Huelle', async () => {
  await assert.rejects(alt.taub({ an: true }), { code: 'UNIMPLEMENTED' });
  assert.deepEqual(anDieHuelle, []);
});

test('bekannte Methode, die die Huelle nie beantwortet: haengt — dafuer die Frist', async () => {
  assert.equal(await haengt(alt.mikrofon({ an: true })), true);
  assert.deepEqual(anDieHuelle, ['Alt.mikrofon']);
});

test('huellenBefund fragt dasselbe Capacitor', async () => {
  const { huellenBefund, huelleKennt } = await import('../src/lib/platform/huelleKann.ts');
  assert.deepEqual(huellenBefund('Alt', ['beitreten', 'taub']), {
    da: false,
    grund: 'methoden-fehlen',
    fehlen: ['taub']
  });
  assert.equal(huelleKennt('Alt', 'mikrofon'), true);
  assert.equal(huelleKennt('Fehlt', 'mikrofon'), false);
});
