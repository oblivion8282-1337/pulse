"""account-recovery: password-reset, email-verify, 2FA/TOTP

Adds 3 columns to ``users`` (``email_verified_at``, ``totp_secret``,
``totp_enabled``) plus 3 sibling tables for the recovery / 2FA flows:

* ``password_reset_tokens``
* ``email_verification_tokens``
* ``user_backup_codes``

All token tables store only ``SHA-256(plaintext)`` — the plaintext leaves the
server in the email body (reset / verify) or the setup response (backup codes)
and is never persisted. A DB-only leak therefore cannot mint reset URLs.

Revision ID: 0006_account_recovery
Revises: 0005_admin_audit_log
Create Date: 2026-05-18 12:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0006_account_recovery"
down_revision: str | None = "0005_admin_audit_log"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("email_verified_at", sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        "users",
        sa.Column("totp_secret", sa.Text(), nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        "users",
        sa.Column(
            "totp_enabled",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
        schema=SCHEMA,
    )

    op.create_table(
        "password_reset_tokens",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("token_hash", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], [f"{SCHEMA}.users.id"], ondelete="CASCADE"
        ),
        sa.UniqueConstraint("token_hash", name="uq_password_reset_tokens_hash"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_password_reset_tokens_user_used",
        "password_reset_tokens",
        ["user_id", "used_at"],
        schema=SCHEMA,
    )

    op.create_table(
        "email_verification_tokens",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("token_hash", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], [f"{SCHEMA}.users.id"], ondelete="CASCADE"
        ),
        sa.UniqueConstraint("token_hash", name="uq_email_verification_tokens_hash"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_email_verification_tokens_user_used",
        "email_verification_tokens",
        ["user_id", "used_at"],
        schema=SCHEMA,
    )

    op.create_table(
        "user_backup_codes",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("code_hash", sa.Text(), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], [f"{SCHEMA}.users.id"], ondelete="CASCADE"
        ),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_user_backup_codes_user",
        "user_backup_codes",
        ["user_id"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_user_backup_codes_user", "user_backup_codes", schema=SCHEMA)
    op.drop_table("user_backup_codes", schema=SCHEMA)
    op.drop_index(
        "ix_email_verification_tokens_user_used",
        "email_verification_tokens",
        schema=SCHEMA,
    )
    op.drop_table("email_verification_tokens", schema=SCHEMA)
    op.drop_index(
        "ix_password_reset_tokens_user_used",
        "password_reset_tokens",
        schema=SCHEMA,
    )
    op.drop_table("password_reset_tokens", schema=SCHEMA)
    op.drop_column("users", "totp_enabled", schema=SCHEMA)
    op.drop_column("users", "totp_secret", schema=SCHEMA)
    op.drop_column("users", "email_verified_at", schema=SCHEMA)
