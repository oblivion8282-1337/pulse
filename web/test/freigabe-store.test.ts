import test from 'node:test';
import assert from 'node:assert/strict';
import { freigabeAnkommen, freigabeHolen, freigabeLeeren } from '../src/lib/freigabe/freigabeStore.ts';

test('Freigabe bleibt liegen, bis sie geleert wird', () => {
  freigabeLeeren();
  freigabeAnkommen({ text: 'Hallo' });
  assert.deepEqual(freigabeHolen(), { text: 'Hallo', bild: null });
  freigabeLeeren();
  assert.equal(freigabeHolen(), null);
});

test('ein zweiter Share ersetzt den ersten', () => {
  freigabeAnkommen({ text: 'erster' });
  freigabeAnkommen({ text: null, bild: { base64: 'QUJD', mime: 'image/png' } });
  const p = freigabeHolen();
  assert.equal(p?.text, null);
  assert.equal(p?.bild?.mime, 'image/png');
  freigabeLeeren();
});

test('leerer Share legt nichts ab', () => {
  freigabeLeeren();
  freigabeAnkommen({ text: '', bild: null });
  assert.equal(freigabeHolen(), null);
});
