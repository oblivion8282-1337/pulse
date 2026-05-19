# Pulse Backup Restore Runbook

Step-by-step recovery for the encrypted restic backups produced by the
`backup` sidecar (see `docker-compose.yml` and `backup.sh`). All commands
run **on the VPS**, from `~/pulse/infra/prod/`, unless noted.

> **Before anything else:** `restic` will refuse to open the repo without
> the correct passphrase, and there is no way to recover from a lost one.
> If you don't have `RESTIC_PASSWORD` in `~/pulse/infra/prod/.env` **and**
> on paper / in a password manager somewhere off-host, stop here — the
> snapshots are ciphertext and stay that way.

## 0. Pre-flight: inspect the repo

The `backup` container has `restic`, the repo password, and the
`pulse_backups` volume preconfigured. To poke around without touching the
running schedule, open a shell:

```bash
docker compose exec backup sh
```

Inside it (or via `docker compose exec backup restic …` from the host):

```bash
restic snapshots                  # everything, all tags
restic snapshots --tag pg         # filter
restic snapshots --tag minio
restic snapshots --tag avatars
restic snapshots --tag guild_icons
restic stats latest               # size of the newest snapshot
restic stats --mode raw-data      # total repo size on disk
```

Each snapshot has a short 8-char ID (left column). The instructions below
write that as `<snapid>`; `latest` (per tag) also works wherever an ID is
expected.

## 1. Restore a single file (cherry-pick)

Most common case — a user reports a deleted attachment, a guild icon was
overwritten. No need to nuke the whole bucket.

```bash
# List paths inside a snapshot.
docker compose exec backup restic ls <snapid>

# Restore one file. --target / would overwrite live state; use /tmp first.
docker compose exec backup restic restore <snapid> \
    --include /var/cache/pulse-backup/minio/<bucket-path> \
    --target /tmp/restore

# Pull it out of the container.
docker cp pulse_backup:/tmp/restore/var/cache/pulse-backup/minio/<bucket-path> ./
```

Then re-upload via `mc cp` (MinIO bucket) or `docker cp` (avatars/icons
volume) — see the bulk sections below for exact paths.

## 2. Full Postgres restore

**This drops the live DB. Schedule downtime.**

The PG snapshot is one file: `pg-dcc.dump` (custom format, `pg_restore`-able).

```bash
# 1) Stop everything that writes to PG.
docker compose stop auth chat-gateway voice-signaling media-svc \
                     mediamtx-auth-hook web

# 2) Pick a snapshot.
docker compose exec backup restic snapshots --tag pg

# 3) Stream the dump out of restic into a host file.
docker compose exec backup restic dump <snapid> /pg-dcc.dump \
    > /tmp/pg-restore.dump

# 4) Drop + recreate the DB, then load the dump.
docker compose exec -T postgres \
    psql -U dcc -d postgres -c 'DROP DATABASE dcc;'
docker compose exec -T postgres \
    psql -U dcc -d postgres -c 'CREATE DATABASE dcc OWNER dcc;'
docker compose exec -T postgres \
    pg_restore -U dcc -d dcc --no-owner --no-privileges \
    < /tmp/pg-restore.dump

# 5) Run migrations in case the live code is ahead of the snapshot schema.
docker compose up -d migrate-auth migrate-chat

# 6) Bring the app back.
docker compose up -d
rm /tmp/pg-restore.dump
```

If `pg_restore` complains about pre-existing objects you can re-run with
`--clean --if-exists`; with a fresh-created DB it shouldn't be needed.

## 3. Full MinIO bucket restore (`pulse-attachments`)

```bash
# 1) Stop the only producer of attachments.
docker compose stop chat-gateway

# 2) Wipe + recreate the bucket from inside MinIO itself.
docker compose exec -T minio sh -c '
    mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" &&
    mc rb --force --dangerous local/pulse-attachments &&
    mc mb local/pulse-attachments
'

# 3) Restore the snapshot to its original path inside the backup container,
#    then mirror it back into MinIO over the network.
docker compose exec backup sh -c '
    rm -rf /var/cache/pulse-backup/minio &&
    restic restore <snapid> --target / \
        --include /var/cache/pulse-backup/minio &&
    mc alias set local "$MINIO_ENDPOINT" "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" &&
    mc mirror --overwrite /var/cache/pulse-backup/minio/ \
        local/pulse-attachments
'

# 4) Back online.
docker compose up -d chat-gateway
```

## 4. Full avatars / guild_icons restore

The `backup` sidecar mounts these volumes **read-only**, so the restore
needs an additional `compose run` that mounts the target volume
read-write. (We restore into `/tmp` inside the container and `cp -a` from
there — restoring straight to `/snapshot/avatars` would hit the RO mount.)

```bash
# avatars (uid 10001 = "app" inside pulse_auth)
docker compose stop auth
docker compose run --rm --no-deps \
    -v pulse_avatars:/restore-target \
    backup sh -c '
        restic restore <snapid> --target /tmp --include /snapshot/avatars &&
        rm -rf /restore-target/* &&
        cp -a /tmp/snapshot/avatars/. /restore-target/ &&
        chown -R 10001:10001 /restore-target
    '
docker compose up -d auth

# guild_icons (same uid)
docker compose stop chat-gateway
docker compose run --rm --no-deps \
    -v pulse_guild_icons:/restore-target \
    backup sh -c '
        restic restore <snapid> --target /tmp --include /snapshot/guild_icons &&
        rm -rf /restore-target/* &&
        cp -a /tmp/snapshot/guild_icons/. /restore-target/ &&
        chown -R 10001:10001 /restore-target
    '
docker compose up -d chat-gateway
```

## 5. Disaster recovery — fresh host

You have only the `pulse_backups` Docker volume contents (e.g. copied from a
dead disk's `/var/lib/docker/volumes/pulse_pulse_backups/`).

1. Install Docker + Compose on the new host.
2. Restore the volume: `mkdir -p /var/lib/docker/volumes/pulse_pulse_backups/_data && cp -a …`.
3. Clone Pulse, restore `~/pulse/infra/prod/.env` (incl. `RESTIC_PASSWORD`!),
   `secrets/jwt_*.pem`, and `certs/server.{crt,key}` from your **off-host**
   secrets store (none of these are in restic — see DEPLOY.md).
4. Rebuild the backup image on the new host so it can read the repo:
   ```bash
   cd ~/pulse/infra/prod && docker compose build backup
   ```
5. Bring up the data layer only:
   ```bash
   docker compose up -d postgres redis minio minio-init backup
   ```
6. Verify the repo opens: `docker compose exec backup restic snapshots`.
7. Follow §2 (Postgres), §3 (MinIO), §4 (avatars + icons) in that order.
8. Finally: `docker compose up -d` to start the app + streaming layer.

## 6. Manual one-off snapshot (before a risky change)

```bash
docker compose exec backup backup.sh pg
docker compose exec backup backup.sh minio
docker compose exec backup backup.sh avatars
docker compose exec backup backup.sh icons
```

These follow the same retention policy on the next `maintenance` run
(weekly forget+prune). To pin a snapshot forever, tag it:

```bash
docker compose exec backup restic tag --add keep <snapid>
```

> Today's crontab does **not** pass `--keep-tag keep` to `restic forget`.
> If you start using `keep`-tags, update `backup.sh::run_maintenance` and
> redeploy first, or your "kept forever" snapshot will be pruned next Sunday.

## 7. Lost the passphrase

There is no recovery. restic uses AES-256-CTR + Poly1305-AES and derives
the master key via scrypt; brute-forcing a 32-byte random passphrase is
infeasible. Start a new repo with a new passphrase (`backup.sh` will
`restic init` on first call against an empty `/repo`).

## 8. TODO: off-host replica

A local-only repo is **not** a real backup against disk loss. Tracked in
`DEPLOY.md`. Sketch:

```bash
# Hetzner Storage Box / S3 / B2 — restic copies ciphertext, no re-encrypt.
docker compose exec backup restic copy --repo /repo \
    --repo2 b2:<bucket-name>:/ --repo2-password-file /repo/.copy-pw
```

Adding this means: a second `RESTIC_REPOSITORY` env var, the copy
credentials in `.env`, and a new cron line right after `maintenance`.
