import { test } from 'node:test';
import assert from 'node:assert/strict';

import { zuSatz, satzZuNachricht } from '../src/lib/verlauf/satz.ts';

test('zuSatz legt reply_to_id mit ab', () => {
  const satz = zuSatz('k1', {
    id: '42',
    author_id: '7',
    content: 'antwort',
    created_at: '2026-08-28T00:00:00Z',
    reply_to_id: '41'
  }, 'konto-a');
  assert.ok(satz);
  assert.equal(satz.antwortAufId, '41');
});

test('zuSatz ohne reply_to_id legt null ab', () => {
  const satz = zuSatz('k1', {
    id: '42',
    author_id: '7',
    content: 'kein bezug',
    created_at: '2026-08-28T00:00:00Z'
  }, 'konto-a');
  assert.ok(satz);
  assert.equal(satz.antwortAufId, null);
});

test('satzZuNachricht liefert reply_to_id beim Nachladen zurueck', () => {
  const satz = zuSatz('k1', {
    id: '42',
    author_id: '7',
    content: 'antwort',
    created_at: '2026-08-28T00:00:00Z',
    reply_to_id: '41'
  }, 'konto-a');
  assert.ok(satz);
  const nachricht = satzZuNachricht(satz);
  assert.equal(nachricht.reply_to_id, '41');
});

test('zuSatz legt krypto_id (kanonische Autor-ID) mit ab', () => {
  const satz = zuSatz('k1', {
    id: '99',
    author_id: '7',
    content: 'empfangen',
    created_at: '2026-08-28T00:00:00Z',
    krypto_id: 'autor-kanonisch-1'
  }, 'konto-a');
  assert.ok(satz);
  assert.equal(satz.kryptoId, 'autor-kanonisch-1');
});

test('satzZuNachricht liefert krypto_id beim Nachladen zurueck, damit spaetere Antworten sie wiederfinden', () => {
  const satz = zuSatz('k1', {
    id: '99',
    author_id: '7',
    content: 'empfangen',
    created_at: '2026-08-28T00:00:00Z',
    krypto_id: 'autor-kanonisch-1'
  }, 'konto-a');
  assert.ok(satz);
  const nachricht = satzZuNachricht(satz);
  assert.equal(nachricht.krypto_id, 'autor-kanonisch-1');
});
