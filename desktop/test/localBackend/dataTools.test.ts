import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuKb } from '../../electron/localBackend/dataTools.ts';
import { updateVerdict } from '../../electron/localBackend/containerBackendManager.ts';

// Update-Entscheidung (Digest-Vergleich laufender Container vs. gepulltes Image)

test('updateVerdict: unterschiedliche IDs → update', () => {
  assert.equal(updateVerdict('abc123', 'def456'), 'update');
});
test('updateVerdict: identische IDs → none', () => {
  assert.equal(updateVerdict('abc123', 'abc123'), 'none');
});
test('updateVerdict: Docker-sha256-Präfix wird normalisiert (Podman ohne Präfix)', () => {
  assert.equal(updateVerdict('sha256:abc123', 'abc123'), 'none');
  assert.equal(updateVerdict('sha256:abc123', 'sha256:def456'), 'update');
});
test('updateVerdict: Whitespace (inspect-Ausgabe endet auf \\n) wird getrimmt', () => {
  assert.equal(updateVerdict('abc123\n', ' abc123 '), 'none');
});
test('updateVerdict: leere/unklare Eingaben → none (fail-safe, kein grundloses Recreate)', () => {
  assert.equal(updateVerdict('', 'abc123'), 'none');
  assert.equal(updateVerdict('abc123', ''), 'none');
  assert.equal(updateVerdict('', ''), 'none');
});

// du-Ausgabe → Bytes

test('parseDuKb: "12345\\t/data" → 12345 KiB in Bytes', () => {
  assert.equal(parseDuKb('12345\t/data\n'), 12345 * 1024);
});
test('parseDuKb: 0 KB → 0 Bytes', () => {
  assert.equal(parseDuKb('0\t/data'), 0);
});
test('parseDuKb: kaputte/leere Ausgabe → null', () => {
  assert.equal(parseDuKb(''), null);
  assert.equal(parseDuKb('du: cannot access'), null);
});
