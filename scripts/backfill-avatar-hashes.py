#!/usr/bin/env python3
"""One-shot backfill: populate ``avatar_hash`` + content-addressed copies for
existing Cloud avatars so they resolve on Self-Host servers.

Self-Hosts fetch a member's Cloud avatar via ``/avatars/by-hash/<hash>.webp``,
keyed by the ``avatar_hash`` carried in the signed profile-statement. Avatars
uploaded before that mechanism existed have ``avatar_hash = NULL`` and no
by-hash copy, so they'd still fall back to initials on Self-Hosts. This script
walks every user that has an avatar file, hashes the stored WEBP bytes, writes
the ``by-hash/<hash>.webp`` copy, and sets ``users.avatar_hash``.

Idempotent: re-running skips users whose hash already matches the file. Run it
on the CLOUD host (it needs the avatar volume + auth DB):

    uv run --package dcc-auth python scripts/backfill-avatar-hashes.py

Add ``--dry-run`` to only report what would change.
"""

from __future__ import annotations

import asyncio
import hashlib
import sys
from pathlib import Path

from sqlalchemy import select

import dcc_auth.config as _config
from dcc_auth.db import SessionLocal
from dcc_auth.models import User


async def _run(dry_run: bool) -> int:
    settings = _config.get_settings()
    avatar_dir = Path(settings.avatar_upload_dir)
    by_hash_dir = avatar_dir / "by-hash"

    updated = 0
    missing_file = 0
    skipped = 0

    async with SessionLocal() as session:
        users = list(
            (await session.execute(select(User).where(User.avatar_url.is_not(None)))).scalars()
        )
        for user in users:
            src = avatar_dir / f"{user.id}.webp"
            if not src.exists():
                missing_file += 1
                continue
            data = src.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            if user.avatar_hash == digest:
                skipped += 1
                continue

            print(f"user {user.id} ({user.username}): avatar_hash -> {digest}")
            if not dry_run:
                by_hash_dir.mkdir(parents=True, exist_ok=True)
                dest = by_hash_dir / f"{digest}.webp"
                if not dest.exists():
                    dest.write_bytes(data)
                user.avatar_hash = digest
                session.add(user)
            updated += 1

        if not dry_run:
            await session.commit()

    verb = "would update" if dry_run else "updated"
    print(
        f"\nDone: {verb} {updated}, already-current {skipped}, "
        f"avatar_url-without-file {missing_file}."
    )
    return 0


def main() -> int:
    dry_run = "--dry-run" in sys.argv[1:]
    return asyncio.run(_run(dry_run))


if __name__ == "__main__":
    raise SystemExit(main())
