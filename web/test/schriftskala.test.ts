import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  MAX_SKALA,
  MIN_SKALA,
  skalaFuerKategorie
} from '../src/lib/platform/schriftskala.ts';

test('die vier kleinen Stufen bleiben bei der Vorgabe', () => {
  for (const k of ['XS', 'S', 'M', 'L']) {
    assert.equal(skalaFuerKategorie(`UICTContentSizeCategory${k}`), MIN_SKALA, k);
  }
});

test('die grossen Stufen wachsen monoton', () => {
  const folge = ['XL', 'XXL', 'XXXL'].map((k) =>
    skalaFuerKategorie(`UICTContentSizeCategory${k}`)
  );
  assert.deepEqual(folge, [...folge].sort((a, b) => a - b));
  assert.ok(folge[0] > MIN_SKALA, 'XL muss ueber der Vorgabe liegen');
});

test('die fuenf AX-Stufen laufen in die Obergrenze, nicht ins Dreifache', () => {
  for (const k of ['M', 'L', 'XL', 'XXL', 'XXXL']) {
    assert.equal(
      skalaFuerKategorie(`UICTContentSizeCategoryAccessibility${k}`),
      MAX_SKALA,
      k
    );
  }
});

test('Unbekanntes und Fehlendes ergibt die Vorgabe, keine wilde Skalierung', () => {
  assert.equal(skalaFuerKategorie(null), MIN_SKALA);
  assert.equal(skalaFuerKategorie(undefined), MIN_SKALA);
  assert.equal(skalaFuerKategorie(''), MIN_SKALA);
  assert.equal(skalaFuerKategorie('UICTContentSizeCategoryAX7_gibtEsNichtMehr'), MIN_SKALA);
});

test('nichts liegt ausserhalb der Grenzen', () => {
  for (const k of Object.keys({ ...{} })) void k;
  for (const k of [
    'UICTContentSizeCategoryXS',
    'UICTContentSizeCategoryXXXL',
    'UICTContentSizeCategoryAccessibilityXXXL'
  ]) {
    const s = skalaFuerKategorie(k);
    assert.ok(s >= MIN_SKALA && s <= MAX_SKALA, `${k} -> ${s}`);
  }
});
