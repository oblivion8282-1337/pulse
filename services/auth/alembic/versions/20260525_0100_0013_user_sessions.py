"""user_sessions — Browser-Session-Cookie-Storage (DE 11 Phase 1, Punkt 3)

Adds ``auth.user_sessions``.  After a successful ``/login`` (Username +
Passwort + MFA wenn gefordert) auth-svc stores a row here and sets an
``HttpOnly + SameSite=strict + Secure`` cookie (``pulse_session=<session_id>``).
The cookie is the only credential accepted by Cloud-only endpoints such as
``POST /credentials/issue`` and the future Admin-UI.

Columns
-------
session_id   — UUID v4 primary key.  Also the raw cookie value (never stored
               in cleartext anywhere else — a DB-only leak yields only UUIDs).
user_id      — Snowflake FK → ``auth.users.id`` (CASCADE on User-delete).
created_at   — Issue timestamp.
last_seen_at — Updated on every authenticated request so the sessions UI can
               show real activity.  Also used to compute a TTL-based inactivity
               timeout.
expires_at   — Absolute hard expiry (~30 min from issue, refreshed on
               activity).  The cleanup cron deletes rows where
               ``expires_at < now()``.
amr          — JSON array of auth-method references from the login that created
               this session, e.g. ``["pwd","otp"]``.  Inherited by
               ``issued_credentials.amr`` when the session is used to issue a
               Cert.
acr          — String level: ``"0"`` = password-only, ``"1"`` = MFA.
user_agent   — Verbatim ``User-Agent`` header at session creation (display
               only; not used for security decisions).
ip           — INET (Postgres) / TEXT (SQLite) client IP at creation time.
               Stored in cleartext unlike the existing ``refresh_tokens.ip_hash``
               because sessions are short-lived (~30 min) and will be GC'd; no
               GDPR-relevant long-term retention.

Revision ID: 0013_user_sessions
Revises: 0012_user_pairwise_salt
Create Date: 2026-05-25 01:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg
from sqlalchemy.dialects import sqlite as _sqlite

revision: str = "0013_user_sessions"
down_revision: str | None = "0012_user_pairwise_salt"
branch_labels = None
depends_on = None

SCHEMA = "auth"

# INET is Postgres-only; fall back to TEXT on SQLite so tests stay hermetic.
_InetOrText = pg.INET().with_variant(sa.Text(), "sqlite")

# UUID primary key: pg.UUID on Postgres, TEXT on SQLite.
_UUIDOrText = pg.UUID(as_uuid=False).with_variant(sa.Text(), "sqlite")

# JSONB on Postgres, plain JSON on SQLite.
_JsonbOrJson = pg.JSONB().with_variant(sa.JSON(), "sqlite")


def upgrade() -> None:
    op.create_table(
        "user_sessions",
        sa.Column("session_id", _UUIDOrText, primary_key=True),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "amr",
            _JsonbOrJson,
            nullable=False,
            server_default=sa.text("'[]'"),
        ),
        sa.Column(
            "acr",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'0'"),
        ),
        sa.Column("user_agent", sa.Text(), nullable=True),
        sa.Column("ip", _InetOrText, nullable=True),
        sa.ForeignKeyConstraint(
            ["user_id"], [f"{SCHEMA}.users.id"], ondelete="CASCADE"
        ),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_user_sessions_user_id",
        "user_sessions",
        ["user_id"],
        schema=SCHEMA,
    )
    op.create_index(
        "ix_user_sessions_expires_at",
        "user_sessions",
        ["expires_at"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_user_sessions_expires_at", "user_sessions", schema=SCHEMA)
    op.drop_index("ix_user_sessions_user_id", "user_sessions", schema=SCHEMA)
    op.drop_table("user_sessions", schema=SCHEMA)
