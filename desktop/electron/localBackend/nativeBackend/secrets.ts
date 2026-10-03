/**
 * Idempotente Secret-Generierung für das native Backend.
 * Portiert 1:1 von infra/self-host/s6/etc/s6-overlay/scripts/03-init-secrets.sh
 * (mit Garage-GK-Schlüsselformat — weed übernimmt die S3-Creds unverändert).
 *
 * Abweichung zum Image: openssl gibt es auf Windows nicht verlässlich →
 * RSA/Ed25519-Keypairs via node:crypto. gleiche PEM-Formate.
 * Regel: jede Datei wird nur geschrieben, wenn sie noch nicht existiert.
 * Niemals Secret-Werte loggen.
 */

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { NativeSecrets } from './types.ts';

/** 32 Bytes → 64 Hex-Zeichen (entspricht Python secrets.token_hex(32)). */
function genHex(): string {
  return randomBytes(32).toString('hex');
}

/** 32 Bytes → URL-safe Base64 ohne Padding (entspricht token_urlsafe(32)). */
function genUrlSafe(): string {
  return randomBytes(32).toString('base64url');
}

function writeIfMissing(filePath: string, value: string): void {
  if (!existsSync(filePath)) writeFileSync(filePath, value, { encoding: 'utf8' });
}

function readOrCreate(filePath: string, generate: () => string): string {
  writeIfMissing(filePath, generate());
  return readFileSync(filePath, 'utf8');
}

function ensureKeypair(
  secretsDir: string,
  privName: string,
  pubName: string,
  alg: 'rsa' | 'ed25519',
): void {
  const privPath = join(secretsDir, privName);
  if (existsSync(privPath)) return;
  // generateKeyPairSync-Overloads verlangen getrennte Aufrufe je Algorithmus.
  const pair = alg === 'rsa'
    ? generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      })
    : generateKeyPairSync('ed25519', {
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });
  writeFileSync(privPath, pair.privateKey, { encoding: 'utf8' });
  writeFileSync(join(secretsDir, pubName), pair.publicKey, { encoding: 'utf8' });
}

export function ensureNativeSecrets(secretsDir: string): NativeSecrets {
  mkdirSync(secretsDir, { recursive: true });

  const postgresPassword = readOrCreate(join(secretsDir, 'postgres.password'), genHex);
  const internalServiceToken = readOrCreate(join(secretsDir, 'internal_service.token'), genUrlSafe);
  const certChallengeSecret = readOrCreate(join(secretsDir, 'cert_challenge.secret'), genUrlSafe);
  // Garage/weed-Key-IDs MÜSSEN "GK" + 24 Hex-Zeichen sein (03-init-secrets.sh:
  // andere Formate werden beim Import abgelehnt — 2026-09-22, Prod wie Self-Host).
  const minioUser = readOrCreate(
    join(secretsDir, 'minio.user'),
    () => `GK${randomBytes(12).toString('hex')}`,
  );
  const minioPassword = readOrCreate(join(secretsDir, 'minio.password'), genHex);
  // LiveKit-Key-Format wie im Image: pulse-selfhost-<8 hex>
  const livekitApiKey = readOrCreate(
    join(secretsDir, 'livekit.key'),
    () => `pulse-selfhost-${randomBytes(4).toString('hex')}`,
  );
  const livekitApiSecret = readOrCreate(join(secretsDir, 'livekit.secret'), genHex);

  ensureKeypair(secretsDir, 'jwt_private.pem', 'jwt_public.pem', 'rsa');
  ensureKeypair(secretsDir, 'session-token-signing.pem', 'session-token-signing.pub.pem', 'ed25519');

  return {
    postgresPassword,
    internalServiceToken,
    certChallengeSecret,
    minioUser,
    minioPassword,
    jwtPrivateKeyPath: join(secretsDir, 'jwt_private.pem'),
    jwtPublicKeyPath: join(secretsDir, 'jwt_public.pem'),
    // SESSION_SIGNING_KEY_FILE zeigt im Image auf session_signing.pem (LAZY vom
    // chat-gateway erzeugt, anderer Name als das Ed25519-Paar oben) — Verbatim.
    sessionSigningKeyPath: join(secretsDir, 'session_signing.pem'),
    livekitApiKey,
    livekitApiSecret,
  };
}
