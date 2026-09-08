import test from 'node:test';
import assert from 'node:assert/strict';
import { istGelesenBis, vorwaertsMerge } from '../src/lib/stores/lesestandKern.ts';

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
