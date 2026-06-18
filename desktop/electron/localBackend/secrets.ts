/**
 * Idempotente Secret-Generierung für den lokalen Self-Host-Stack.
 * Portiert 1:1 von infra/self-host/s6/etc/s6-overlay/scripts/03-init-secrets.sh.
 *
 * Regel: jede Datei wird nur geschrieben, wenn sie noch nicht existiert.
 * Niemals Secret-Werte loggen.
 */
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface Secrets {
  postgresPassword: string;
  internalServiceToken: string;
  certChallengeSecret: string;
  minioUser: string;
  minioPassword: string;
  jwtPrivateKeyPath: string;
  jwtPublicKeyPath: string;
  sessionSigningKeyPath: string;
  livekitApiKey: string;
  livekitApiSecret: string;
}

/** Schreibt `value` nach `filePath` (nur wenn fehlend) und setzt chmod 600. */
function writeIfMissing(filePath: string, value: string, mode = 0o600): void {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, value, { encoding: 'utf8' });
    if (process.platform !== 'win32') {
      chmodSync(filePath, mode);
    }
  }
}

/** Liest eine vorhandene Datei oder erzeugt sie mit `generate()` und gibt den Inhalt zurück. */
function readOrCreate(filePath: string, generate: () => string, mode = 0o600): string {
  writeIfMissing(filePath, generate(), mode);
  return readFileSync(filePath, 'utf8');
}

/** 32 Bytes → 64 Hex-Zeichen (entspricht Python secrets.token_hex(32)). */
function genHex(): string {
  return randomBytes(32).toString('hex');
}

/** 32 Bytes → URL-safe Base64 ohne Padding (entspricht Python secrets.token_urlsafe(32)). */
function genUrlSafe(): string {
  return randomBytes(32).toString('base64url');
}

/** Erzeugt das RSA-2048-Keypair und schreibt beide PEM-Dateien, wenn jwt_private.pem fehlt. */
function ensureRsaKeypair(secretsDir: string): void {
  const privPath = join(secretsDir, 'jwt_private.pem');
  const pubPath = join(secretsDir, 'jwt_public.pem');
  if (!existsSync(privPath)) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    writeFileSync(privPath, privateKey, { encoding: 'utf8' });
    writeFileSync(pubPath, publicKey, { encoding: 'utf8' });
    if (process.platform !== 'win32') {
      chmodSync(privPath, 0o600);
      chmodSync(pubPath, 0o644);
    }
  }
}

/** Erzeugt das Ed25519-Keypair und schreibt beide PEM-Dateien, wenn session-token-signing.pem fehlt. */
function ensureEd25519Keypair(secretsDir: string): void {
  const privPath = join(secretsDir, 'session-token-signing.pem');
  const pubPath = join(secretsDir, 'session-token-signing.pub.pem');
  if (!existsSync(privPath)) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    writeFileSync(privPath, privateKey, { encoding: 'utf8' });
    writeFileSync(pubPath, publicKey, { encoding: 'utf8' });
    if (process.platform !== 'win32') {
      chmodSync(privPath, 0o600);
      chmodSync(pubPath, 0o644);
    }
  }
}

/**
 * Stellt sicher, dass alle Self-Host-Secrets in `secretsDir` vorhanden sind.
 * Fehlende Dateien werden erzeugt; vorhandene bleiben unverändert (idempotent).
 */
export async function ensureSecrets(secretsDir: string): Promise<Secrets> {
  mkdirSync(secretsDir, { recursive: true });
  if (process.platform !== 'win32') {
    chmodSync(secretsDir, 0o700);
  }

  const postgresPassword = readOrCreate(join(secretsDir, 'postgres.password'), genHex);
  const internalServiceToken = readOrCreate(
    join(secretsDir, 'internal_service.token'),
    genUrlSafe,
  );
  const certChallengeSecret = readOrCreate(
    join(secretsDir, 'cert_challenge.secret'),
    genUrlSafe,
  );
  const minioUser = readOrCreate(
    join(secretsDir, 'minio.user'),
    () => `pulse-${randomBytes(4).toString('hex')}`,
  );
  const minioPassword = readOrCreate(join(secretsDir, 'minio.password'), genHex);

  ensureRsaKeypair(secretsDir);
  ensureEd25519Keypair(secretsDir);

  const livekitApiSecret = readOrCreate(join(secretsDir, 'livekit.secret'), genHex);

  return {
    postgresPassword,
    internalServiceToken,
    certChallengeSecret,
    minioUser,
    minioPassword,
    jwtPrivateKeyPath: join(secretsDir, 'jwt_private.pem'),
    jwtPublicKeyPath: join(secretsDir, 'jwt_public.pem'),
    sessionSigningKeyPath: join(secretsDir, 'session-token-signing.pem'),
    livekitApiKey: 'pulse-selfhost',
    livekitApiSecret,
  };
}

/**
 * Self-signed RSA-2048-Cert für MediaMTX-RTMPS (CN/SAN = hostname).
 * Idempotent: nur erzeugen, wenn mediamtx.crt fehlt. Niemals den Key loggen.
 */
export function ensureMediamtxCert(
  secretsDir: string,
  hostname: string,
): { certPath: string; keyPath: string } {
  mkdirSync(secretsDir, { recursive: true });
  const certPath = join(secretsDir, 'mediamtx.crt');
  const keyPath = join(secretsDir, 'mediamtx.key');
  if (!existsSync(certPath)) {
    execFileSync('openssl', [
      'req', '-x509', '-nodes', '-newkey', 'rsa:2048',
      '-keyout', keyPath, '-out', certPath, '-days', '3650',
      '-subj', `/CN=${hostname}`, '-addext', `subjectAltName=DNS:${hostname}`,
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    if (process.platform !== 'win32') {
      chmodSync(keyPath, 0o600);
      chmodSync(certPath, 0o644);
    }
  }
  return { certPath, keyPath };
}
