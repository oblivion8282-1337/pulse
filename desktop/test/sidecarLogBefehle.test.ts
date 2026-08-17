import { test } from 'node:test';
import assert from 'node:assert/strict';

import { befehlZeile, ohneGeheimnisse } from '../electron/sidecar-log-befehle.ts';

// ── Positivliste ────────────────────────────────────────────────────────────

test('Lebenszyklus-Befehle gehen durch', () => {
  for (const op of ['start', 'stop', 'shutdown', 'open', 'close']) {
    assert.ok(befehlZeile({ op, id: 1 }), `${op} fehlt im Protokoll`);
  }
});

test('die Eingabe-Flut der Fernsteuerung bleibt draussen', () => {
  // Bis zu 125 Anfragen je Sekunde — einzeln protokolliert waere die Datei in
  // Minuten voll und rotierte genau das weg, wonach jemand sucht.
  assert.equal(befehlZeile({ op: 'remote_input', id: 2, frames: ['x'] }), null);
  assert.equal(befehlZeile({ op: 'input_capture', id: 3 }), null);
  assert.equal(befehlZeile({ op: 'stats', id: 4 }), null);
  assert.equal(befehlZeile({ op: 'health', id: 5 }), null);
});

test('ein unbekannter Op ist stumm, nicht laut', () => {
  // Die Richtung der Positivliste: was niemand eingetragen hat, flutet nicht.
  assert.equal(befehlZeile({ op: 'irgendwas_neues', id: 6 }), null);
});

test('ohne `op` gibt es keine Zeile', () => {
  assert.equal(befehlZeile({ id: 7 }), null);
  assert.equal(befehlZeile({ op: 42, id: 8 }), null);
});

// ── Geheimnisse ─────────────────────────────────────────────────────────────

test('der Stream-Token taucht nirgends auf — auch nicht verschachtelt', () => {
  const zeile = befehlZeile({
    op: 'start',
    id: 9,
    channel: {
      id: '123',
      token: 'geheim-abc',
      push_url: 'rtmps://host:1936/live?pass=geheim-abc',
    },
  });
  assert.ok(zeile);
  assert.ok(!zeile.includes('geheim-abc'), `Token im Protokoll: ${zeile}`);
  // Was KEIN Geheimnis ist, bleibt lesbar — sonst waere die Zeile wertlos.
  assert.ok(zeile.includes('"op":"start"'));
  assert.ok(zeile.includes('"id":"123"'));
});

test('grosszuegig maskiert: jeder Feldname, der nach Geheimnis klingt', () => {
  const aus = ohneGeheimnisse({
    token: 'a',
    push_url: 'b',
    pushUrl: 'c',
    stream_key: 'd',
    apiSecret: 'e',
    pass: 'f',
    credentials: 'g',
    WHEP_URL: 'h',
  }) as Record<string, unknown>;
  for (const [feld, wert] of Object.entries(aus)) {
    assert.equal(wert, '***', `${feld} wurde nicht maskiert`);
  }
});

test('harmlose Felder bleiben unangetastet', () => {
  const aus = ohneGeheimnisse({
    op: 'start',
    capture: 'monitor-1',
    show_cursor: true,
    av_offset_ms: -20,
    audio: { mode: 'Desktop', excluded_apps: ['spotify'] },
  });
  assert.deepEqual(aus, {
    op: 'start',
    capture: 'monitor-1',
    show_cursor: true,
    av_offset_ms: -20,
    audio: { mode: 'Desktop', excluded_apps: ['spotify'] },
  });
});

test('Listen von Objekten werden mitgenommen', () => {
  const aus = ohneGeheimnisse([{ token: 'a' }, { name: 'b' }]);
  assert.deepEqual(aus, [{ token: '***' }, { name: 'b' }]);
});

test('null und undefined werfen nicht', () => {
  assert.equal(ohneGeheimnisse(null), null);
  assert.equal(ohneGeheimnisse(undefined), undefined);
  assert.deepEqual(ohneGeheimnisse({ a: null }), { a: null });
});

test('ein Geheimnis tief im Baum wird auch dort gefunden', () => {
  const aus = ohneGeheimnisse({ a: { b: { c: { token: 'geheim' } } } });
  assert.deepEqual(aus, { a: { b: { c: { token: '***' } } } });
});
