"""Vereintes Antragssystem — instance_applications.origin + app_host-Übernahme

Pulse hatte ZWEI parallele Antrags-/Genehmigungssysteme (VPS-Self-Host in
``instance_applications``, App-Hosting in ``app_host_applications``).
Entscheidung 2026-07-13: EIN Antragssystem, ``origin`` unterscheidet
(vps | app_host) — Vorbereitung auf Monetarisierung („approved" wird später
„bezahlt").

Schritte:
1. ``origin``-Spalte (Text, NOT NULL, default 'vps').
2. Datenübernahme aus ``app_host_applications``:
   - user_id → applicant_user_id, message → notes; Status-Werte
     (pending|approved|rejected|revoked) werden 1:1 übernommen —
     ``instance_applications.status`` ist ein freies Text-Feld, 'revoked'
     kommt als neuer (app_host-only) Wert dazu.
   - hostname (NOT NULL, App-Host-Anträge haben keinen): synthetischer
     Platzhalter ``app-<antrags-id>.<relay_base>`` — dasselbe Muster wie die
     App-Host-Instanzen aus instance_provisioning.py.
   - contact_email (NOT NULL): aus ``users.email`` des Antragstellers
     (JOIN — verwaiste Anträge gibt es nicht, FK ist CASCADE).
   - expected_users (NOT NULL): 1 (App-Hosting hat keine User-Schätzung).
   - approved_instance_id: NULL — der alte App-Host-Weg verknüpfte die
     provisionierte Instanz nie mit dem Antrag; rückwirkend nicht eindeutig
     rekonstruierbar (revoke sucht ohnehin über registered_by+origin).
3. ``app_host_applications`` DROPpen (Modell + Routen sind entfernt).

Revision ID: 0044_unified_applications
Revises: 0043_users_fk_ondelete
Create Date: 2026-07-13
"""
from __future__ import annotations

import os

import sqlalchemy as sa
from alembic import op

revision: str = "0044_unified_applications"
down_revision: str | None = "0043_users_fk_ondelete"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.add_column(
        "instance_applications",
        sa.Column(
            "origin",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'vps'"),
        ),
        schema=SCHEMA,
    )
    # Platzhalter-Suffix wie zur Laufzeit (instance_provisioning.py liest
    # dieselbe Env-Var über pydantic-settings) — rein kosmetisch, existiert
    # nicht im DNS.
    suffix = "." + os.environ.get("PULSE_RELAY_BASE_DOMAIN", "relay.howispulse.com")
    op.get_bind().execute(
        sa.text(
            """
            INSERT INTO auth.instance_applications
                (id, applicant_user_id, hostname, purpose, expected_users,
                 contact_email, notes, status, reviewed_by, reviewed_at,
                 rejection_reason, approved_instance_id, created_at, origin)
            SELECT a.id, a.user_id,
                   'app-' || a.id::text || :suffix,
                   a.purpose, 1, u.email, a.message, a.status,
                   a.reviewed_by, a.reviewed_at, a.rejection_reason,
                   NULL, a.created_at, 'app_host'
            FROM auth.app_host_applications a
            JOIN auth.users u ON u.id = a.user_id
            """
        ),
        {"suffix": suffix},
    )
    op.drop_table("app_host_applications", schema=SCHEMA)


def downgrade() -> None:
    # Best-effort: Tabelle wiederherstellen (Struktur wie Migration 0035),
    # app_host-Zeilen zurückkopieren, dann origin-Spalte fallen lassen.
    op.create_table(
        "app_host_applications",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("purpose", sa.Text(), nullable=False),
        sa.Column("message", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("reviewed_by", sa.BigInteger(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("rejection_reason", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], [f"{SCHEMA}.users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["reviewed_by"], [f"{SCHEMA}.users.id"], ondelete="SET NULL"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_app_host_applications_user_status",
        "app_host_applications",
        ["user_id", "status"],
        schema=SCHEMA,
    )
    op.create_index(
        "ix_app_host_applications_status",
        "app_host_applications",
        ["status"],
        schema=SCHEMA,
    )
    op.execute(
        sa.text(
            """
            INSERT INTO auth.app_host_applications
                (id, user_id, purpose, message, status, reviewed_by,
                 reviewed_at, rejection_reason, created_at)
            SELECT id, applicant_user_id, purpose, notes, status, reviewed_by,
                   reviewed_at, rejection_reason, created_at
            FROM auth.instance_applications
            WHERE origin = 'app_host'
            """
        )
    )
    op.execute(
        sa.text("DELETE FROM auth.instance_applications WHERE origin = 'app_host'")
    )
    op.drop_column("instance_applications", "origin", schema=SCHEMA)
