import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erzeugeVorschauCache } from '../src/lib/einladung/vorschauCache.ts';

const dauerhaft = (e: unknown) => e === 'nein';

test('Erfolg wird bis zum Ablauf wiederverwendet', async () => {
  let t = 0;
  let aufrufe = 0;
  const c = erzeugeVorschauCache<number>(dauerhaft, () => t, 1000);
  const laden = async () => ++aufrufe;
  assert.equal(await c.holen('a', laden), 1);
  t = 999;
  assert.equal(await c.holen('a', laden), 1);
  t = 1000;
  assert.equal(await c.holen('a', laden), 2);
  assert.equal(aufrufe, 2);
});

test('dauerhafte Ablehnung wird gemerkt', async () => {
  let aufrufe = 0;
  const c = erzeugeVorschauCache<number>(dauerhaft, () => 0, 1000);
  const laden = () => {
    aufrufe++;
    return Promise.reject('nein');
  };
  await assert.rejects(c.holen('a', laden));
  await assert.rejects(c.holen('a', laden));
  assert.equal(aufrufe, 1);
});

test('flüchtige Fehler werden nicht gemerkt', async () => {
  let aufrufe = 0;
  const c = erzeugeVorschauCache<number>(dauerhaft, () => 0, 1000);
  const laden = () => {
    aufrufe++;
    return Promise.reject('429');
  };
  await assert.rejects(c.holen('a', laden));
  await new Promise((r) => setTimeout(r, 0));
  await assert.rejects(c.holen('a', laden));
  assert.equal(aufrufe, 2);
});

test('verschiedene Codes sind getrennt', async () => {
  const c = erzeugeVorschauCache<string>(dauerhaft, () => 0, 1000);
  assert.equal(await c.holen('a', async () => 'A'), 'A');
  assert.equal(await c.holen('b', async () => 'B'), 'B');
});
