import test from 'node:test';
import assert from 'node:assert/strict';
import {
  istGelesenBis,
  vorwaertsMerge,
  lesestandAnker
} from '../src/lib/stores/lesestandKern.ts';

test('vorwaertsMerge nimmt den zeitlich größeren Stand', () => {
  assert.equal(vorwaertsMerge('900000000000000001', '900000000000000002'), '900000000000000002');
  assert.equal(vorwaertsMerge('900000000000000002', '900000000000000001'), '900000000000000002');
  assert.equal(vorwaertsMerge(undefined, '900000000000000001'), '900000000000000001');
  // Stellen-Grenze: 18 Ziffern (künftiger Snowflake) schlagen 17 — der
  // eingebettete-Zeit-Vergleich ordnet das korrekt, ein String-Vergleich täte es nicht.
  assert.equal(vorwaertsMerge('99999999999999999', '100000000000000000'), '100000000000000000');
});

test('istGelesenBis liefert die dreiwertige Antwort', () => {
  assert.equal(istGelesenBis(undefined, '100'), null);
  assert.equal(istGelesenBis('150', '100'), true);
  assert.equal(istGelesenBis('150', '150'), true);
  assert.equal(istGelesenBis('150', '200'), false);
});

// Befund B3 (Testrunde echtes Gerät 2026-09-11): Empfänger kannte die
// Nachricht unter der Zustellungs-ID (Server-Snowflake), der Sender
// vergleicht gegen seine lokale ID — gleiche Nachricht, ~200 ms
// auseinander, Häkchen blieb für immer einfach.
test('lesestandAnker nimmmt die kanonische Absender-ID, sonst die eigene', () => {
  // Empfangene verschlüsselte Nachricht: Zustellungs-ID + mitgekommene
  // Absender-ID (exakte Werte aus dem Befund).
  const empfangen = { id: '91878994424635393', krypto_id: '1789131259499624939' };
  assert.equal(lesestandAnker(empfangen), '1789131259499624939');
  // Eigene Nachricht (Sendegerät) und Klartext-Weg: keine krypto_id.
  assert.equal(lesestandAnker({ id: '1789131259499624939' }), '1789131259499624939');
});

test('Anker auf der kanonischen ID schließt den B3-Kreis', () => {
  const lokaleId = '1789131259499624939';
  const zustellungsId = '91878994424635393';
  // Empfänger anchor't den gemeldeten Lesestand an der kanonischen ID:
  const partnerStand = lesestandAnker({ id: zustellungsId, krypto_id: lokaleId });
  // alt (kaputt): Stand an der Zustellungs-ID, Vergleich gegen die lokale ID
  assert.equal(istGelesenBis(zustellungsId, lokaleId), false);
  // neu: beide Seiten führen dieselbe Kennung → Häkchen kommt zustande
  assert.equal(istGelesenBis(partnerStand, lokaleId), true);
});
