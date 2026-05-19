"""smtp_settings singleton

Admin-managed SMTP config persisted in the DB so a self-hoster can wire up
recovery-/verify-emails without touching ``.env`` + restarting the service.
``email.py`` reads this row first; if ``configured = false`` it falls back
to the env-based ``Settings.smtp_*`` (back-compat with existing deployments).

``password_encrypted`` is a Fernet ciphertext — the key is derived from the
JWT private key (see ``dcc_auth.crypto``). Rotating the JWT keypair renders
the stored SMTP password unreadable; the operator simply re-enters it.

Revision ID: 0008_smtp_settings
Revises: 0007_refresh_token_metadata
Create Date: 2026-05-19 12:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0008_smtp_settings"
down_revision: str | None = "0007_refresh_token_metadata"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.create_table(
        "smtp_settings",
        sa.Column("id", sa.SmallInteger(), primary_key=True),
        # Provider preset chosen by the admin. ``custom`` = host/port edited
        # by hand. The known presets short-circuit the host/port/use_ssl
        # fields in the UI so the admin only types creds.
        sa.Column(
            "provider",
            sa.String(length=16),
            server_default="custom",
            nullable=False,
        ),
        sa.Column("host", sa.String(length=255), nullable=True),
        sa.Column("port", sa.Integer(), server_default="587", nullable=False),
        sa.Column("username", sa.String(length=255), nullable=True),
        # Fernet ciphertext (base64) of the SMTP password / API key. Empty
        # string when not yet entered — we never store the plaintext.
        sa.Column("password_encrypted", sa.Text(), nullable=True),
        sa.Column("from_email", sa.String(length=255), nullable=True),
        sa.Column(
            "use_ssl",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
        # Flips to true on the first successful PATCH /admin/smtp. ``email.py``
        # uses this as the gate: configured=false ⇒ fall through to env / log.
        sa.Column(
            "configured",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint("id = 1", name="ck_smtp_settings_singleton"),
        schema=SCHEMA,
    )
    op.execute(f"INSERT INTO {SCHEMA}.smtp_settings (id) VALUES (1)")


def downgrade() -> None:
    op.drop_table("smtp_settings", schema=SCHEMA)
