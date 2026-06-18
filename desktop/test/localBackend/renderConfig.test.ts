import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderEnv } from '../../electron/localBackend/renderConfig.ts';
import { makeDataDirs, FIXTURE_SECRETS, FIXTURE_PORTS } from './fixtures.ts';

const dirs = makeDataDirs('/data');
const secrets = FIXTURE_SECRETS;
const ports = FIXTURE_PORTS;
const identity = { hostname: 'host.local', instanceId: '123', ownerId: '999' };

describe('renderEnv', () => {
  test('baut DATABASE_URL + self-host-Identität', () => {
    const env = renderEnv({ dirs, secrets, ports, identity });
    assert.equal(env.DATABASE_URL, 'postgresql+asyncpg://pulse:PW@127.0.0.1:5432/dcc');
    assert.equal(env.REDIS_URL, 'redis://127.0.0.1:6379/0');
    assert.equal(env.PULSE_INSTANCE_MODE, 'self-host');
    assert.equal(env.PULSE_INSTANCE_ID, '123');
  });

  test('setzt Postgres-Einzelfelder korrekt', () => {
    const env = renderEnv({ dirs, secrets, ports, identity });
    assert.equal(env.POSTGRES_USER, 'pulse');
    assert.equal(env.POSTGRES_PASSWORD, 'PW');
    assert.equal(env.POSTGRES_DB, 'dcc');
    assert.equal(env.POSTGRES_HOST, '127.0.0.1');
    assert.equal(env.POSTGRES_PORT, '5432');
  });

  test('setzt REDIS_URL mit dynamischem Port', () => {
    const env = renderEnv({
      dirs,
      secrets,
      ports: { ...ports, redis: 6380 },
      identity,
    });
    assert.equal(env.REDIS_URL, 'redis://127.0.0.1:6380/0');
  });

  test('setzt JWT-Key-Pfade aus Secrets', () => {
    const env = renderEnv({ dirs, secrets, ports, identity });
    assert.equal(env.JWT_PRIVATE_KEY_FILE, '/data/secrets/jwt_private.pem');
    assert.equal(env.JWT_PUBLIC_KEY_FILE, '/data/secrets/jwt_public.pem');
    assert.equal(env.SESSION_SIGNING_KEY_FILE, '/data/secrets/session-token-signing.pem');
  });

  test('setzt JWT-Konfiguration mit Hostname', () => {
    const env = renderEnv({ dirs, secrets, ports, identity });
    assert.equal(env.JWT_ISSUER, 'https://host.local');
    assert.equal(env.JWT_AUDIENCE, 'pulse-self-host');
    assert.equal(env.JWT_ACCESS_TTL_SECONDS, '900');
    assert.equal(env.JWT_REFRESH_TTL_SECONDS, '2592000');
  });

  test('setzt interne Dienst-Endpunkte mit dynamischen Ports', () => {
    const env = renderEnv({ dirs, secrets, ports, identity });
    assert.equal(env.INTERNAL_SERVICE_SECRET, 'TOK');
    assert.equal(env.CHAT_GATEWAY_URL, 'http://127.0.0.1:8002');
    assert.equal(env.MEDIA_SVC_URL, 'http://127.0.0.1:8004');
    assert.equal(env.AUTH_JWKS_URL, 'http://127.0.0.1:8001/.well-known/jwks.json');
    assert.equal(env.CHAT_GATEWAY_CHALLENGE_SECRET, 'CERT');
    assert.equal(env.PULSE_JWT_AUDIENCE, 'dcc');
  });

  test('setzt CORS_ALLOW_ORIGINS und WebAuthn', () => {
    const env = renderEnv({ dirs, secrets, ports, identity });
    assert.equal(env.CORS_ALLOW_ORIGINS, 'https://howispulse.com,https://host.local');
    assert.equal(env.WEBAUTHN_RP_ID, 'host.local');
    assert.equal(env.WEBAUTHN_ORIGIN, 'https://host.local');
  });

  test('setzt Snowflake-Worker-IDs', () => {
    const env = renderEnv({ dirs, secrets, ports, identity });
    assert.equal(env.SNOWFLAKE_WORKER_ID_AUTH, '1');
    assert.equal(env.SNOWFLAKE_WORKER_ID_CHAT, '2');
    assert.equal(env.SNOWFLAKE_WORKER_ID_VOICE, '3');
  });

  test('setzt PULSE_INSTANCE_OWNER_ID und PULSE_HOSTNAME', () => {
    const env = renderEnv({ dirs, secrets, ports, identity });
    assert.equal(env.PULSE_INSTANCE_OWNER_ID, '999');
    assert.equal(env.PULSE_HOSTNAME, 'host.local');
  });

  test('setzt Upload-Verzeichnisse aus DataDirs', () => {
    const env = renderEnv({ dirs, secrets, ports, identity });
    assert.equal(env.AVATAR_UPLOAD_DIR, '/data/uploads/avatars');
    assert.equal(env.GUILD_ICON_UPLOAD_DIR, '/data/uploads/guild-icons');
  });

  test('setzt MinIO/S3-Konfiguration', () => {
    const env = renderEnv({ dirs, secrets, ports, identity });
    assert.equal(env.MINIO_ROOT_USER, 'minio-user');
    assert.equal(env.MINIO_ROOT_PASSWORD, 'minio-pass');
    assert.equal(env.S3_INTERNAL_ENDPOINT, 'http://127.0.0.1:9000');
    assert.equal(env.S3_PUBLIC_ENDPOINT, 'https://host.local');
    assert.equal(env.S3_BUCKET, 'pulse-attachments');
    assert.equal(env.S3_REGION, 'us-east-1');
    assert.equal(env.S3_ACCESS_KEY, 'minio-user');
    assert.equal(env.S3_SECRET_KEY, 'minio-pass');
    assert.equal(env.MINIO_SERVER_URL, 'https://host.local');
  });

  test('setzt MinIO-Port dynamisch', () => {
    const env = renderEnv({
      dirs,
      secrets,
      ports: { ...ports, minio: 9001 },
      identity,
    });
    assert.equal(env.S3_INTERNAL_ENDPOINT, 'http://127.0.0.1:9001');
  });

  test('setzt VAPID_KEY_FILE', () => {
    const env = renderEnv({ dirs, secrets, ports, identity });
    assert.equal(env.VAPID_KEY_FILE, '/data/secrets/vapid.json');
  });

  test('rendert LIVEKIT_/MEDIAMTX_-Vars', () => {
    const env = renderEnv({ dirs, secrets, ports, identity });
    assert.equal(env.LIVEKIT_API_KEY, secrets.livekitApiKey);
    assert.equal(env.LIVEKIT_API_URL, 'http://127.0.0.1:7880');
    assert.equal(env.LIVEKIT_URL, 'wss://host.local/livekit');
    assert.equal(env.MEDIAMTX_PUBLIC_BASE, 'https://host.local/whep');
  });

  test('nutzt relaySubdomain als public origin (Origin-Switch)', () => {
    const env = renderEnv({
      dirs,
      secrets,
      ports,
      identity: { ...identity, relaySubdomain: 'brave-otter-4f2a.relay.howispulse.com' },
    });
    // Nach-außen-Origins zeigen auf die Relay-Subdomain …
    assert.equal(env.JWT_ISSUER, 'https://brave-otter-4f2a.relay.howispulse.com');
    assert.equal(env.WEBAUTHN_RP_ID, 'brave-otter-4f2a.relay.howispulse.com');
    assert.equal(env.WEBAUTHN_ORIGIN, 'https://brave-otter-4f2a.relay.howispulse.com');
    assert.match(env.CORS_ALLOW_ORIGINS, /brave-otter-4f2a\.relay\.howispulse\.com/);
    assert.equal(env.MINIO_SERVER_URL, 'https://brave-otter-4f2a.relay.howispulse.com');
    assert.equal(env.S3_PUBLIC_ENDPOINT, 'https://brave-otter-4f2a.relay.howispulse.com');
    // … interne URLs bleiben localhost.
    assert.match(env.DATABASE_URL, /@127\.0\.0\.1:/);
    assert.equal(env.PULSE_HOSTNAME, 'host.local');
  });
});
