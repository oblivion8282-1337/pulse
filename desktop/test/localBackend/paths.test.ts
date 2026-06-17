import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dataDir, resolveBinary, BinaryNotFoundError } from '../../electron/localBackend/paths.ts';

describe('dataDir', () => {
  test('legt das Layout unter pulse-host/data ab', () => {
    const d = dataDir('/u');
    assert.equal(d.root, '/u/pulse-host/data');
    assert.equal(d.pg, '/u/pulse-host/data/pg');
    assert.equal(d.redis, '/u/pulse-host/data/redis');
    assert.equal(d.minio, '/u/pulse-host/data/minio');
    assert.equal(d.uploadsAvatars, '/u/pulse-host/data/uploads/avatars');
    assert.equal(d.uploadsGuildIcons, '/u/pulse-host/data/uploads/guild-icons');
    assert.equal(d.secrets, '/u/pulse-host/data/secrets');
    assert.equal(d.backups, '/u/pulse-host/data/backups');
  });
});

describe('resolveBinary', () => {
  test('wirft BinaryNotFoundError wenn Binary nirgends gefunden wird', () => {
    assert.throws(
      () => resolveBinary('postgres', { PULSE_HOST_BIN: '/nonexistent-dir-xyz-abc' }),
      BinaryNotFoundError,
    );
  });

  test('gibt PULSE_HOST_BIN/<name> zurueck wenn die Datei existiert', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pulse-test-'));
    try {
      const fakeBin = join(tmpDir, 'postgres');
      writeFileSync(fakeBin, '#!/bin/sh\n');
      chmodSync(fakeBin, 0o755);
      const result = resolveBinary('postgres', { PULSE_HOST_BIN: tmpDir });
      assert.equal(result, fakeBin);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});
