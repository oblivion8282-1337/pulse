"""webauthn_credentials: passkey / FIDO2 credential storage

Adds one table for the WebAuthn 2FA + passwordless-login feature. The table
holds only public material (credential id, COSE public key, sign counter) —
the authenticator keeps the private key, so a DB-only leak cannot forge a
login assertion. ``credential_id`` / ``public_key`` are base64url *text*
(not BLOBs) so the schema is identical on the SQLite test backend.

No ``users`` columns are added: "has a passkey" is derived from a row count,
unlike TOTP which needs the ``totp_enabled`` flag because the secret column
is populated before the user confirms setup.

Revision ID: 0010_webauthn_credentials
Revises: 0009_email_gate_grandfather
Create Date: 2026-05-21 16:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0010_webauthn_credentials"
down_revision: str | None = "0009_email_gate_grandfather"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.create_table(
        "webauthn_credentials",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("credential_id", sa.Text(), nullable=False),
        sa.Column("public_key", sa.Text(), nullable=False),
        sa.Column(
            "sign_count", sa.BigInteger(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("aaguid", sa.String(length=36), nullable=True),
        sa.Column("transports", JSONB(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["user_id"], [f"{SCHEMA}.users.id"], ondelete="CASCADE"
        ),
        sa.UniqueConstraint("credential_id", name="uq_webauthn_credentials_cred_id"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_webauthn_credentials_user",
        "webauthn_credentials",
        ["user_id"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_webauthn_credentials_user", "webauthn_credentials", schema=SCHEMA
    )
    op.drop_table("webauthn_credentials", schema=SCHEMA)
