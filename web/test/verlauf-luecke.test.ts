import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  betrifftLuecke,
  lueckeMarkieren,
  lueckeNachServerantwortAktualisieren,
  _lueckenZuruecksetzenFuerTest
} from '../src/lib/verlauf/luecke.ts';

test('ohne bekannte Luecke ist jeder Cursor unbedenklich', () => {
  _lueckenZuruecksetzenFuerTest();
  assert.equal(betrifftLuecke('kanal-1', '12345'), false);
});

test('ein Cursor bei oder unter der oberen Luecken-Grenze ist betroffen', () => {
  _lueckenZuruecksetzenFuerTest();
  // Vor dem Sprung zuletzt bekannt: '100'. Neue Seite beginnt bei '900'.
  // Alles dazwischen (101..899) wurde nie abgeholt.
  lueckeMarkieren('kanal-1', '100', '900');
  assert.equal(betrifftLuecke('kanal-1', '900'), true); // genau die obere Grenze
  assert.equal(betrifftLuecke('kanal-1', '500'), true); // mitten in der Luecke
  assert.equal(betrifftLuecke('kanal-1', '100'), true); // an/unter der unteren Grenze zaehlt ebenfalls als betroffen
});

test('ein Cursor oberhalb der oberen Grenze ist NICHT betroffen', () => {
  _lueckenZuruecksetzenFuerTest();
  lueckeMarkieren('kanal-1', '100', '900');
  assert.equal(betrifftLuecke('kanal-1', '950'), false);
});

test('eine Luecke ist kanalspezifisch', () => {
  _lueckenZuruecksetzenFuerTest();
  lueckeMarkieren('kanal-1', '100', '900');
  assert.equal(betrifftLuecke('kanal-2', '500'), false);
});

test('reicht die Serverantwort bis zur unteren Grenze, schliesst sie die Luecke', () => {
  _lueckenZuruecksetzenFuerTest();
  lueckeMarkieren('kanal-1', '100', '900');
  lueckeNachServerantwortAktualisieren('kanal-1', '100', false);
  assert.equal(betrifftLuecke('kanal-1', '500'), false);
});

test('reicht die Serverantwort NICHT bis zur unteren Grenze, wird nur die obere Grenze nachgezogen', () => {
  _lueckenZuruecksetzenFuerTest();
  lueckeMarkieren('kanal-1', '100', '900');
  // Seite voll (nicht kuerzer als angefragt) und aelteste Nachricht '600' —
  // die Luecke bleibt (100..600), nur enger als vorher.
  lueckeNachServerantwortAktualisieren('kanal-1', '600', false);
  assert.equal(betrifftLuecke('kanal-1', '900'), false); // oberhalb der neuen Grenze frei
  assert.equal(betrifftLuecke('kanal-1', '600'), true); // an der neuen Grenze weiterhin betroffen
  assert.equal(betrifftLuecke('kanal-1', '300'), true); // im verbleibenden Rest weiterhin betroffen
});

test('eine kuerzere Antwort als angefragt (Historie-Ende) schliesst die Luecke ebenfalls', () => {
  _lueckenZuruecksetzenFuerTest();
  lueckeMarkieren('kanal-1', '100', '900');
  // Server liefert nur '700' zurueck, obwohl mehr angefragt war — Historie
  // endet dort, unterhalb existiert ohnehin nichts mehr, das die Luecke
  // noch betreffen koennte.
  lueckeNachServerantwortAktualisieren('kanal-1', '700', true);
  assert.equal(betrifftLuecke('kanal-1', '800'), false);
});

test('eine leere Antwort schliesst die Luecke', () => {
  _lueckenZuruecksetzenFuerTest();
  lueckeMarkieren('kanal-1', '100', '900');
  lueckeNachServerantwortAktualisieren('kanal-1', undefined, false);
  assert.equal(betrifftLuecke('kanal-1', '500'), false);
});
