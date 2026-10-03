/**
 * Env-Vertrag für die nativen Services.
 * Portiert 1:1 von infra/self-host/s6/etc/s6-overlay/scripts/07-render-env.sh —
 * der Ports-Satz ist identisch (NATIVE_PORTS spiegelt den Container-Internraum).
 *
 * Reine Funktion — kein I/O, kein Secret-Logging.
 */

import { join } from 'node:path';

import { NATIVE_PORTS } from './types.ts';
import type { NativeDataDirs, NativeSecrets } from './types.ts';

export interface NativeIdentity {
  hostname: string;
  instanceId: string;
  ownerId: string;
  clientId: string;
  clientSecret: string;
  cloudOrigin: string;
  adminEmail?: string;
}

const CLOUD_ORIGIN_DEFAULT = 'https://howispulse.com';

export function renderNativeEnv(
  dirs: NativeDataDirs,
  secrets: NativeSecrets,
  identity: NativeIdentity,
): Record<string, string> {
  const hostname = identity.hostname;
  const cloudOrigin = identity.cloudOrigin || CLOUD_ORIGIN_DEFAULT;
  const p = NATIVE_PORTS;
  const keys = dirs.secrets;

  return {
    // Postgres (local TCP, no TLS — same process tree)
    POSTGRES_USER: 'pulse',
    POSTGRES_PASSWORD: secrets.postgresPassword,
    POSTGRES_DB: 'dcc',
    POSTGRES_HOST: '127.0.0.1',
    POSTGRES_PORT: String(p.postgres),
    DATABASE_URL: `postgresql+asyncpg://pulse:${secrets.postgresPassword}@127.0.0.1:${p.postgres}/dcc`,

    // Redis/Garnet (local-only bind, no auth — single-machine threat model)
    REDIS_URL: `redis://127.0.0.1:${p.garnet}/0`,

    // JWT (RS256 chat-gateway issuer)
    JWT_PRIVATE_KEY_FILE: join(keys, 'jwt_private.pem'),
    JWT_PUBLIC_KEY_FILE: join(keys, 'jwt_public.pem'),
    JWT_ISSUER: `https://${hostname}`,
    JWT_AUDIENCE: 'pulse-self-host',
    JWT_ACCESS_TTL_SECONDS: '900',
    JWT_REFRESH_TTL_SECONDS: '2592000',

    // Self-Host session-token signing (Ed25519, lazy vom chat-gateway erzeugt)
    SESSION_SIGNING_KEY_FILE: join(keys, 'session_signing.pem'),

    // Internal cross-service auth
    INTERNAL_SERVICE_SECRET: secrets.internalServiceToken,
    CHAT_GATEWAY_URL: `http://127.0.0.1:${p.chat}`,
    MEDIA_SVC_URL: `http://127.0.0.1:${p.media}`,
    AUTH_SVC_URL: `http://127.0.0.1:${p.auth}`,
    AUTH_JWKS_URL: `http://127.0.0.1:${p.auth}/.well-known/jwks.json`,

    // Cert-login challenge HMAC
    CHAT_GATEWAY_CHALLENGE_SECRET: secrets.certChallengeSecret,

    // Cloud-Cert JWT audience
    PULSE_JWT_AUDIENCE: 'dcc',

    // CORS
    CORS_ALLOW_ORIGINS: `${cloudOrigin},https://${hostname}`,

    // WebAuthn
    WEBAUTHN_RP_ID: hostname,
    WEBAUTHN_ORIGIN: `https://${hostname}`,

    // Snowflake worker IDs (single-instance — fixed)
    SNOWFLAKE_WORKER_ID_AUTH: '1',
    SNOWFLAKE_WORKER_ID_CHAT: '2',

    // Self-host identity
    PULSE_HOSTNAME: hostname,
    PULSE_INSTANCE_MODE: 'self-host',
    PULSE_INSTANCE_ID: identity.instanceId,
    PULSE_INSTANCE_OWNER_ID: identity.ownerId,
    PULSE_CLOUD_ORIGIN: cloudOrigin,
    PULSE_ADMIN_EMAIL: identity.adminEmail || `admin@${hostname}`,
    PULSE_CLOUD_CLIENT_ID: identity.clientId,
    PULSE_CLOUD_CLIENT_SECRET: identity.clientSecret,
    // App-Host ohne Relay (Entscheid 2026-09-27): kein Tunnel-Token.
    PULSE_RELAY_TUNNEL_TOKEN: '',
    PULSE_HOST_ORIGIN: 'app_host',
    PULSE_TLS_MODE: 'behind-proxy',
    PULSE_DATA_PATH: dirs.root,

    // Upload-Verzeichnisse (persistente Dirs statt relativer Defaults)
    AVATAR_UPLOAD_DIR: dirs.uploadsAvatars,
    GUILD_ICON_UPLOAD_DIR: dirs.uploadsGuildIcons,

    // S3 (weed statt Garage — gleiche Env-Oberfläche)
    S3_INTERNAL_ENDPOINT: `http://127.0.0.1:${p.s3}`,
    S3_PUBLIC_ENDPOINT: `https://${hostname}`,
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'pulse-attachments',
    S3_ACCESS_KEY: secrets.minioUser,
    S3_SECRET_KEY: secrets.minioPassword,

    // LiveKit (voice-signaling mints tokens; livekit-server validates)
    LIVEKIT_API_KEY: secrets.livekitApiKey,
    LIVEKIT_API_SECRET: secrets.livekitApiSecret,
    LIVEKIT_URL: `wss://${hostname}/livekit`,
    LIVEKIT_API_URL: `http://127.0.0.1:${p.livekitApi}`,

    // MediaMTX — API intern, Ingest über Loopback (App-Host: RTMPS ist nicht
    // durch NAT zu lochen, Owner pusht lokal — wie im Container mit hostNet).
    MEDIAMTX_API_URL: `http://127.0.0.1:9997/v3/paths/list`,
    MEDIAMTX_INGEST_HOST: '127.0.0.1',
    MEDIAMTX_PUBLIC_BASE: `https://${hostname}/whep`,
    MEDIAMTX_PUSH_PROTOCOL: 'whip',

    // Logging
    PULSE_LOG_LEVEL: 'info',

    // VAPID (Web-Push, lazy vom chat-gateway erzeugt)
    VAPID_KEY_FILE: join(keys, 'vapid.json'),
  };
}
