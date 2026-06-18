import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSecrets, ensureMediamtxCert } from '../../electron/localBackend/secrets.ts';

describe('ensureSecrets', () => {
  test('generiert einmalig und ist danach idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec-'));
    try {
      const a = await ensureSecrets(dir);

      // postgres.password = 64-Hex-Zeichen
      const pwFile = join(dir, 'postgres.password');
      const pwContent = readFileSync(pwFile, 'utf8');
      assert.match(pwContent, /^[0-9a-f]{64}$/);
      assert.ok(pwContent.length > 32);

      if (process.platform !== 'win32') {
        assert.equal(statSync(pwFile).mode & 0o777, 0o600);
      }

      // minio.user hat das Format pulse-<8hex>
      const minioUserFile = join(dir, 'minio.user');
      assert.match(readFileSync(minioUserFile, 'utf8'), /^pulse-[0-9a-f]{8}$/);

      // RSA-Keypair-Dateien existieren
      assert.ok(readFileSync(a.jwtPrivateKeyPath, 'utf8').includes('PRIVATE KEY'));
      assert.ok(readFileSync(a.jwtPublicKeyPath, 'utf8').includes('PUBLIC KEY'));

      // Ed25519-Session-Key existiert
      assert.ok(readFileSync(a.sessionSigningKeyPath, 'utf8').includes('PRIVATE KEY'));

      // Idempotenz: zweiter Aufruf liefert dieselben Werte
      const b = await ensureSecrets(dir);
      assert.equal(b.postgresPassword, a.postgresPassword);
      assert.equal(b.internalServiceToken, a.internalServiceToken);
      assert.equal(b.certChallengeSecret, a.certChallengeSecret);
      assert.equal(b.minioUser, a.minioUser);
      assert.equal(b.minioPassword, a.minioPassword);
      assert.equal(b.jwtPrivateKeyPath, a.jwtPrivateKeyPath);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('gibt Pfade zurueck die auf die Dateien zeigen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec-'));
    try {
      const s = await ensureSecrets(dir);
      assert.equal(s.jwtPrivateKeyPath, join(dir, 'jwt_private.pem'));
      assert.equal(s.jwtPublicKeyPath, join(dir, 'jwt_public.pem'));
      assert.equal(s.sessionSigningKeyPath, join(dir, 'session-token-signing.pem'));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

test('ensureSecrets liefert LiveKit-Key + Secret (idempotent)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sec-lk-'));
  try {
    const a = await ensureSecrets(dir);
    assert.equal(a.livekitApiKey, 'pulse-selfhost');
    assert.match(a.livekitApiSecret, /^[0-9a-f]{64}$/);
    const b = await ensureSecrets(dir);
    assert.equal(b.livekitApiSecret, a.livekitApiSecret); // stabil
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ensureMediamtxCert erzeugt Cert+Key idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sec-cert-'));
  try {
    const { certPath, keyPath } = ensureMediamtxCert(dir, 'host.relay.test');
    assert.ok(existsSync(certPath) && existsSync(keyPath));
    const again = ensureMediamtxCert(dir, 'host.relay.test');
    assert.equal(again.certPath, certPath);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
