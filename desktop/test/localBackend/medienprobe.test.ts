import { test } from 'node:test';
import assert from 'node:assert/strict';
import { istLivekitAntwort } from '../../electron/localBackend/medienprobe.ts';

test('LiveKits eigene Antwort zählt', () => {
  assert.equal(istLivekitAntwort(200, 'OK'), true);
  assert.equal(istLivekitAntwort(200, 'OK\n'), true);
});

test('Caddys Catch-all und Relay-Fehler zählen nicht (Scan 2026-10-08)', () => {
  // Genau diese Antwort machte das Glied vorher bei totem LiveKit grün.
  assert.equal(istLivekitAntwort(200, '<!doctype html><html><head></head><body></body></html>'), false);
  assert.equal(istLivekitAntwort(404, 'not found'), false);
  assert.equal(istLivekitAntwort(502, ''), false);
});
