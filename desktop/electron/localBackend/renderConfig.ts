/**
 * Env-Rendering für den lokalen Self-Host-Stack.
 * Portiert 1:1 von infra/self-host/s6/etc/s6-overlay/scripts/07-render-env.sh.
 *
 * Erzeugt die Env-Map, die jeder uvicorn-Service erbt.
 *
 * BEWUSST AUSGELASSENE ENV-VARS (gehören zu anderen Slices):
 * - PULSE_ADMIN_EMAIL: nur für Let's Encrypt/Caddy (Reachability-Slice) + Cloud-Notifications
 * - PULSE_CLOUD_CLIENT_ID/PULSE_CLOUD_CLIENT_SECRET: Cloud-Pairing (Slices 3–4), noch kein Consumer
 * - LIVEKIT_*: Media-Slice (Voice/WebRTC)
 * - MEDIAMTX_*: Media-Slice (HQ-Streaming)
 * - PULSE_LOG_LEVEL override: derzeit hardcoded auf 'info'; Override-Slot kann bei Bedarf hinzugefügt werden
 *
 * Regel: Niemals Secret-Werte loggen.
 */
import { join } from 'node:path';
import type { DataDirs } from './types.ts';
import type { Secrets } from './secrets.ts';

export interface Ports {
  postgres: number;
  redis: number;
  minio: number;
  auth: number;
  chat: number;
  media: number;
}

export interface FixtureIdentity {
  hostname: string;
  instanceId: string;
  ownerId: string;
  relaySubdomain?: string;
}

export interface RenderEnvInput {
  dirs: DataDirs;
  secrets: Secrets;
  ports: Ports;
  identity: FixtureIdentity;
}

const CLOUD_ORIGIN = 'https://howispulse.com';

/**
 * Baut die vollständige Env-Map für alle uvicorn-Services des lokalen Stacks.
 * Reine Funktion — kein I/O, kein Logging.
 */
export function renderEnv(input: RenderEnvInput): Record<string, string> {
  const { dirs, secrets, ports, identity } = input;
  const { hostname, instanceId, ownerId } = identity;
  const publicOrigin = identity.relaySubdomain ?? hostname;
  const { postgres, redis, minio, auth, chat, media } = ports;

  return {
    // Postgres
    POSTGRES_USER: 'pulse',
    POSTGRES_PASSWORD: secrets.postgresPassword,
    POSTGRES_DB: 'dcc',
    POSTGRES_HOST: '127.0.0.1',
    POSTGRES_PORT: String(postgres),
    DATABASE_URL: `postgresql+asyncpg://pulse:${secrets.postgresPassword}@127.0.0.1:${postgres}/dcc`,

    // Redis
    REDIS_URL: `redis://127.0.0.1:${redis}/0`,

    // JWT (RS256 auth-svc issuer)
    JWT_PRIVATE_KEY_FILE: secrets.jwtPrivateKeyPath,
    JWT_PUBLIC_KEY_FILE: secrets.jwtPublicKeyPath,
    JWT_ISSUER: `https://${publicOrigin}`,
    JWT_AUDIENCE: 'pulse-self-host',
    JWT_ACCESS_TTL_SECONDS: '900',
    JWT_REFRESH_TTL_SECONDS: '2592000',

    // Session-token signing (Ed25519 — für /cert-login)
    SESSION_SIGNING_KEY_FILE: secrets.sessionSigningKeyPath,

    // Interne Dienst-Kommunikation
    INTERNAL_SERVICE_SECRET: secrets.internalServiceToken,
    CHAT_GATEWAY_URL: `http://127.0.0.1:${chat}`,
    MEDIA_SVC_URL: `http://127.0.0.1:${media}`,
    AUTH_JWKS_URL: `http://127.0.0.1:${auth}/.well-known/jwks.json`,

    // Cert-login challenge HMAC
    CHAT_GATEWAY_CHALLENGE_SECRET: secrets.certChallengeSecret,

    // Cloud-Cert JWT audience (Certs tragen Cloud-Audience "dcc")
    PULSE_JWT_AUDIENCE: 'dcc',

    // CORS
    CORS_ALLOW_ORIGINS: `${CLOUD_ORIGIN},https://${publicOrigin}`,

    // WebAuthn — publicOrigin muss eine bare Domain ohne Port sein (RP-ID-Invariante).
    WEBAUTHN_RP_ID: publicOrigin,
    WEBAUTHN_ORIGIN: `https://${publicOrigin}`,

    // Snowflake Worker IDs (Single-Container — fest)
    SNOWFLAKE_WORKER_ID_AUTH: '1',
    SNOWFLAKE_WORKER_ID_CHAT: '2',
    SNOWFLAKE_WORKER_ID_VOICE: '3',

    // Self-Host-Identität — PULSE_HOSTNAME bleibt der physische interne Hostname,
    // nicht publicOrigin; Backend-Services nutzen ihn nur intern.
    PULSE_HOSTNAME: hostname,
    PULSE_INSTANCE_MODE: 'self-host',
    PULSE_INSTANCE_ID: instanceId,
    PULSE_INSTANCE_OWNER_ID: ownerId,
    PULSE_CLOUD_ORIGIN: CLOUD_ORIGIN,

    // Upload-Verzeichnisse
    AVATAR_UPLOAD_DIR: dirs.uploadsAvatars,
    GUILD_ICON_UPLOAD_DIR: dirs.uploadsGuildIcons,

    // MinIO / S3
    MINIO_ROOT_USER: secrets.minioUser,
    MINIO_ROOT_PASSWORD: secrets.minioPassword,
    MINIO_SERVER_URL: `https://${publicOrigin}`,
    S3_INTERNAL_ENDPOINT: `http://127.0.0.1:${minio}`,
    S3_PUBLIC_ENDPOINT: `https://${publicOrigin}`,
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'pulse-attachments',
    S3_ACCESS_KEY: secrets.minioUser,
    S3_SECRET_KEY: secrets.minioPassword,

    // Logging
    PULSE_LOG_LEVEL: 'info',

    // VAPID (Web-Push)
    VAPID_KEY_FILE: join(dirs.secrets, 'vapid.json'),
  };
}
