// Gemeinsame Test-Fixtures für localBackend-Tests.
import type { DataDirs } from '../../electron/localBackend/types.ts';
import type { Secrets } from '../../electron/localBackend/secrets.ts';
import type { Ports } from '../../electron/localBackend/renderConfig.ts';

export function makeDataDirs(root: string): DataDirs {
  return {
    root,
    pg: `${root}/pg`,
    redis: `${root}/redis`,
    minio: `${root}/minio`,
    uploadsAvatars: `${root}/uploads/avatars`,
    uploadsGuildIcons: `${root}/uploads/guild-icons`,
    secrets: `${root}/secrets`,
    backups: `${root}/backups`,
  };
}

export const FIXTURE_SECRETS: Secrets = {
  postgresPassword: 'PW',
  internalServiceToken: 'TOK',
  certChallengeSecret: 'CERT',
  minioUser: 'minio-user',
  minioPassword: 'minio-pass',
  jwtPrivateKeyPath: '/data/secrets/jwt_private.pem',
  jwtPublicKeyPath: '/data/secrets/jwt_public.pem',
  sessionSigningKeyPath: '/data/secrets/session-token-signing.pem',
  livekitApiKey: 'pulse-selfhost',
  livekitApiSecret: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

export const FIXTURE_PORTS: Ports = {
  postgres: 5432, redis: 6379, minio: 9000, auth: 8001, chat: 8002, media: 8004,
};
