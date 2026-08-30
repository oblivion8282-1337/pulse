"""Gerätezertifikate abräumen: issued_credentials + revoked_credentials

Die Anmeldung an einem Self-Host läuft seit dem 2026-08-28 über ein kurzlebiges
Cloud-Ticket. Ein Gerätezertifikat wird nirgends mehr ausgestellt, geprüft oder
widerrufen; der Code dafür ist entfallen.

**Diese Migration löscht Daten und ist nicht zurückzunehmen.** Der Rückweg legt
die Tabellen leer wieder an — die Zertifikate selbst sind dann weg. Das ist
vertretbar, weil sie ohne den prüfenden Code ohnehin nichts mehr ausrichten: Ein
Self-Host akzeptiert sie nicht mehr, und niemand kann sie noch einlösen.

Warum der Grabstein mitgeht
---------------------------
``revoked_credentials`` gab es, weil ``issued_credentials`` per CASCADE an
``users`` hängt: Nach einer Kontolöschung war die Zeile mit der ``cert_id`` weg,
und ein Widerruf, der nur dort lebte, wäre danach nicht bloss ungeschrieben,
sondern unmöglich gewesen — niemand kannte die Kennung mehr. Diese Sorge fällt
mit dem Zertifikat selbst: Ein Ticket lebt 60 Sekunden, es gibt nichts
nachträglich zurückzuziehen.

Nicht angetastet
----------------
``username_reservations`` liegt im selben Modul (``models_credentials``), hat
aber nichts mit Zertifikaten zu tun und bleibt.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# Revision-ID max. 32 Zeichen — ``alembic_version.version_num`` ist
# ``varchar(32)``, eine längere ID lässt die Prod-Migration zurückrollen.
revision: str = "0051_drop_geraete_zerts"
down_revision: str | None = "0050_refresh_token_kette"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.drop_table("revoked_credentials", schema=SCHEMA)
    op.drop_table("issued_credentials", schema=SCHEMA)


def downgrade() -> None:
    """Legt die Tabellen leer wieder an.

    Die Daten kommen nicht zurück — sie sind beim Upgrade gelöscht worden. Der
    Rückweg existiert, damit die Migrationskette vollständig bleibt, nicht als
    Wiederherstellung.
    """
    op.create_table(
        "issued_credentials",
        sa.Column("cert_id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("device_pubkey", sa.LargeBinary(), nullable=False),
        sa.Column("device_label", sa.Text(), nullable=False),
        sa.Column(
            "issued_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["user_id"], [f"{SCHEMA}.users.id"], ondelete="CASCADE"
        ),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_issued_credentials_expires_at",
        "issued_credentials",
        ["expires_at"],
        schema=SCHEMA,
    )
    op.create_index(
        "ix_issued_credentials_user_active",
        "issued_credentials",
        ["user_id"],
        unique=False,
        schema=SCHEMA,
        postgresql_where=sa.text("revoked_at IS NULL"),
    )
    op.create_index(
        "uq_issued_cred_user_pubkey_active",
        "issued_credentials",
        ["user_id", "device_pubkey"],
        unique=True,
        schema=SCHEMA,
        postgresql_where=sa.text("revoked_at IS NULL"),
    )
    op.create_table(
        "revoked_credentials",
        sa.Column("cert_id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_revoked_credentials_expires_at",
        "revoked_credentials",
        ["expires_at"],
        schema=SCHEMA,
    )
