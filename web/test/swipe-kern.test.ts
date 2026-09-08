import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANTWORT_SCHWELLE,
  fuehrtZuAntwort,
  klemmeOffset,
  pfeilDeckkraft
} from '../src/lib/utils/swipeKern.ts';

test('nur deutlich horizontale Züge führen zur Antwort', () => {
  assert.equal(fuehrtZuAntwort(60, 3), true);
  assert.equal(fuehrtZuAntwort(-60, 3), true);
  assert.equal(fuehrtZuAntwort(30, 40), false); // vertikal dominiert → Scrollen
  assert.equal(fuehrtZuAntwort(10, 2), false); // zu kurz
  assert.equal(fuehrtZuAntwort(0, 60), false);
});

test('klemmeOffset kappet beidseitig', () => {
  assert.equal(klemmeOffset(120), ANTWORT_SCHWELLE + 8);
  assert.equal(klemmeOffset(-120), -(ANTWORT_SCHWELLE + 8));
  assert.equal(klemmeOffset(20), 20);
});

test('pfeilDeckkraft wächst bis zur Schwelle und bleibt bei 1', () => {
  assert.equal(pfeilDeckkraft(0), 0);
  assert.equal(pfeilDeckkraft(ANTWORT_SCHWELLE / 2), 0.5);
  assert.equal(pfeilDeckkraft(ANTWORT_SCHWELLE), 1);
  assert.equal(pfeilDeckkraft(-ANTWORT_SCHWELLE * 3), 1);
});
