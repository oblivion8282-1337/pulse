"""issued_credentials — Identitäts-Cert-Storage (DE 11 A.1 + A.5 + A.9)

Adds ``auth.issued_credentials``.  Each row represents one device-bound
Identitäts-Cert issued via ``POST /credentials/issue``.  A user may hold up to
20 active rows (DE 11 A.5); the endpoint enforces this limit.

Columns
-------
cert_id        — UUID v4, also the ``cert_id`` claim in the issued JWT.  Used
                 as the CRL lookup key: ``GET /.well-known/revoked-credentials``
                 returns all cert_ids where ``revoked_at IS NOT NULL`` and
                 ``expires_at > now()``.
user_id        — Snowflake FK → ``auth.users.id`` (CASCADE on User-delete).
device_pubkey  — Raw Ed25519 public-key bytes (32 bytes).  Stored as
                 BYTEA/BLOB; never used server-side for crypto — only echoed
                 back into the JWT claim so the Self-Host can verify
                 Challenge-Response signatures.
device_label   — User-provided human-readable label ("Mein Laptop").
issued_at      — When the Cert was issued.  Also the JWT ``iat`` claim.
expires_at     — Hard expiry (~1 year).  Certs older than this are safe to
                 purge; they are implicitly invalid even without a CRL entry.
revoked_at     — Nullable; set when the user (or admin) explicitly revokes the
                 device.  Rows where this is non-null AND ``expires_at > now()``
                 appear in the CRL response.

Indexes
-------
Partial index on (user_id) WHERE revoked_at IS NULL — the hot path is listing
active certs for a user.  Full-table scan on revoked rows is acceptable.
Index on (expires_at) — used by the cleanup cron and the CRL endpoint's WHERE
clause.

Revision ID: 0014_issued_credentials
Revises: 0013_user_sessions
Create Date: 2026-05-25 02:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision: str = "0014_issued_credentials"
down_revision: str | None = "0013_user_sessions"
branch_labels = None
depends_on = None

SCHEMA = "auth"

_UUIDOrText = pg.UUID(as_uuid=False).with_variant(sa.Text(), "sqlite")


def upgrade() -> None:
    op.create_table(
        "issued_credentials",
        sa.Column("cert_id", _UUIDOrText, primary_key=True),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("device_pubkey", sa.LargeBinary(), nullable=False),
        sa.Column("device_label", sa.Text(), nullable=False),
        sa.Column(
            "issued_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["user_id"], [f"{SCHEMA}.users.id"], ondelete="CASCADE"
        ),
        schema=SCHEMA,
    )
    # Partial index: only active (non-revoked) certs — the list-devices hot path.
    # SQLite does not support partial indexes in Alembic create_index, so we use
    # raw SQL on Postgres and a plain index on SQLite (via postgresql_where).
    op.create_index(
        "ix_issued_credentials_user_active",
        "issued_credentials",
        ["user_id"],
        schema=SCHEMA,
        postgresql_where=sa.text("revoked_at IS NULL"),
    )
    op.create_index(
        "ix_issued_credentials_expires_at",
        "issued_credentials",
        ["expires_at"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_issued_credentials_expires_at", "issued_credentials", schema=SCHEMA
    )
    op.drop_index(
        "ix_issued_credentials_user_active", "issued_credentials", schema=SCHEMA
    )
    op.drop_table("issued_credentials", schema=SCHEMA)
