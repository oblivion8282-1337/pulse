"""revoke_existing_refresh_tokens — Big-Bang-Migration auf Cert-Modell

Alle bestehenden aktiven Refresh-Tokens werden revoked. User müssen sich nach
diesem Deploy einmal neu einloggen; beim Re-Login generiert der Browser ein
Keypair, holt Cert + Profile-Statement → ab da gilt das Cert-Modell (DE 11 F).

Hintergrund (SELF_HOST_PLAN.md DE 11 F):
- pairwise_salt wurde in Migration 0012 per gen_random_bytes(32)-Default gesetzt.
- Das Cert-Modell ersetzt Cloud-signierte Refresh-Tokens als primäres Auth-Artefakt.
- Migration ist no-op auf leerer DB (Tests haben keine echten Tokens).
- Akzeptables Risiko bei Pulse-Beta-Größe.

Revision ID: 0018_revoke_refresh_tokens
Revises: 0017_cred_pubkey_unique
Create Date: 2026-05-26 02:00:00
"""
from __future__ import annotations

from datetime import datetime, timezone

import sqlalchemy as sa
from alembic import op

revision: str = "0018_revoke_refresh_tokens"
down_revision: str | None = "0017_cred_pubkey_unique"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    # Revoke all active refresh tokens so User müssen sich einmal neu einloggen
    # und dabei Cert + Profile-Statement holen.
    #
    # SQLite-Kompatibilität: kein Schema-Prefix (aiosqlite kennt kein "auth."),
    # Postgres akzeptiert schema-qualified Namen.
    #
    # Funktioniert als no-op wenn keine Tokens existieren (leere Test-DB).
    bind = op.get_bind()
    dialect = bind.dialect.name

    if dialect == "postgresql":
        bind.execute(
            sa.text(
                "UPDATE auth.refresh_tokens SET revoked_at = NOW() WHERE revoked_at IS NULL"
            )
        )
    else:
        # SQLite: kein Schema-Prefix, kein NOW() → datetime('now')
        bind.execute(
            sa.text(
                "UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE revoked_at IS NULL"
            )
        )


def downgrade() -> None:
    # Big-Bang-Migration nicht reversibel: die Tokens sind weg.
    # User müssen sich ohnehin neu einloggen — ein Restore würde nur tote
    # Token-Zeilen reaktivieren, die dann beim nächsten Refresh-Versuch
    # sowieso mit 401 scheitern.
    pass
