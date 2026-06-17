export interface SpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface DataDirs {
  root: string;
  pg: string;
  redis: string;
  minio: string;
  uploadsAvatars: string;
  uploadsGuildIcons: string;
  secrets: string;
  backups: string;
}

export type BinaryName =
  | 'postgres'
  | 'initdb'
  | 'pg_ctl'
  | 'psql'
  | 'redis-server'
  | 'minio'
  | 'uvicorn'
  | 'alembic';
