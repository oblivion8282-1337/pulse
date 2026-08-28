import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ART_GRUPPENNACHRICHT,
  baueVerteilNutzlast,
  leseVerteilNutzlast,
  baueGruppenhuelle,
  leseGruppenhuelle,
  neueSitzungId
} from '../src/lib/krypto/gruppe/gruppenNutzlast.ts';
import {
  baueNachrichtNutzlast,
  leseNachrichtNutzlast
} from '../src/lib/krypto/nachrichtNutzlast.ts';

test('ein Verteilschluessel ueberlebt Hin- und Rueckweg', () => {
  const bytes = baueVerteilNutzlast('99', 'sitz-1', 'AAAAschluessel');
  assert.deepEqual(leseVerteilNutzlast(bytes), {
    kanal: '99',
    sitzung: 'sitz-1',
    schluessel: 'AAAAschluessel'
  });
});

test('alles, was kein Verteilschluessel ist, ergibt null', () => {
  const enc = new TextEncoder();
  assert.equal(leseVerteilNutzlast(enc.encode('reiner Text')), null);
  assert.equal(leseVerteilNutzlast(enc.encode('{"v":1,"text":"hallo"}')), null);
  // Fehlt ein Feld, ist es keiner — fail-closed, ein halb gelesener
  // Schluessel ergaebe eine unbrauchbare Sitzung.
  assert.equal(
    leseVerteilNutzlast(enc.encode('{"v":1,"typ":"gruppenschluessel","kanal":"9"}')),
    null
  );
  // Falsche Fassung ebenfalls.
  assert.equal(
    leseVerteilNutzlast(
      enc.encode('{"v":2,"typ":"gruppenschluessel","kanal":"9","sitzung":"s","schluessel":"k"}')
    ),
    null
  );
});

test('eine gewoehnliche Nachricht ist kein Verteilschluessel und umgekehrt', () => {
  const nachricht = baueNachrichtNutzlast('hallo', '123', null);
  assert.equal(leseVerteilNutzlast(nachricht), null);
});

test('WARUM die Lesereihenfolge im Empfangsweg feststeht', () => {
  // Der Beleg fuer die Regel aus dem Modulkopf von `gruppenNutzlast.ts`:
  // `leseNachrichtNutzlast` faellt bei allem, was kein Fassung-1-Objekt MIT
  // `text` ist, auf den Legacy-Zweig zurueck und gibt den ROHEN Klartext als
  // Nachrichtentext aus. Ein Verteilschluessel hat kein `text` — wer ihn
  // zuerst durch den Nachrichten-Leser schickt, stellt dem Nutzer den
  // Gruppenschluessel als Chat-Nachricht ins Fenster und legt ihn im lokalen
  // Verlauf ab. Dieser Test haelt genau das fest, damit die Reihenfolge im
  // Empfangsweg nicht versehentlich gedreht wird.
  const bytes = baueVerteilNutzlast('99', 'sitz-1', 'GEHEIM');
  const falschHerum = leseNachrichtNutzlast(bytes);
  assert.ok(falschHerum.text.includes('GEHEIM'));
  assert.equal(falschHerum.id, null);
  // Richtig herum faellt derselbe Klartext gar nicht erst an den
  // Nachrichten-Leser.
  assert.ok(leseVerteilNutzlast(bytes) !== null);
});

test('die Huelle einer Gruppennachricht ueberlebt Hin- und Rueckweg', () => {
  const daten = baueGruppenhuelle('sitz-1', 'AwgAEiAmegolm');
  assert.deepEqual(leseGruppenhuelle(daten), { sitzung: 'sitz-1', nachricht: 'AwgAEiAmegolm' });
});

test('eine unlesbare Huelle ergibt null statt zu werfen', () => {
  // Der Aufrufer laesst die Zustellung dann liegen (nicht quittieren) — ein
  // Wurf mitten im Abholzyklus wuerde stattdessen alles dahinter aufhalten.
  assert.equal(leseGruppenhuelle('kein base64 !!!'), null);
  assert.equal(leseGruppenhuelle(btoa('kein json')), null);
  assert.equal(leseGruppenhuelle(btoa('{"v":2,"sitzung":"s","nachricht":"n"}')), null);
  assert.equal(leseGruppenhuelle(btoa('{"v":1,"sitzung":"s"}')), null);
});

test('die Umschlagsart kollidiert nicht mit den beiden Olm-Arten', () => {
  // 0 = Olm-Sitzungsaufbau, 1 = laufende Olm-Nachricht (Krypto-Kern,
  // `models/postfach.py`). Waere die Gruppenart eine davon, versuchte der
  // Empfangsweg, einen Megolm-Geheimtext ueber eine Olm-Sitzung zu oeffnen.
  assert.notEqual(ART_GRUPPENNACHRICHT, 0);
  assert.notEqual(ART_GRUPPENNACHRICHT, 1);
});

test('Sitzungskennungen sind eindeutig und hexadezimal', () => {
  const eine = neueSitzungId();
  assert.match(eine, /^[0-9a-f]{32}$/);
  const menge = new Set(Array.from({ length: 200 }, () => neueSitzungId()));
  assert.equal(menge.size, 200);
});
