"""guilds: Ablage pro Community freischaltbar + Speicher-Obergrenze

Fügt zwei Spalten hinzu, beide gesetzt NUR vom Instanz-Betreiber über
``/owner/communities/{id}/limits``:

* ``dropbox_allowed``      — die *Erlaubnis*-Ebene der Ablage
* ``dropbox_quota_bytes``  — die *Obergrenze* für ihren Speicher
                             (NULL = Instanz-Standard, 1 GiB)

Die Obergrenze ist nötig, weil ``dropbox_configs.total_quota_bytes`` an
MANAGE_GUILD hängt: eine Community konnte sich ihren Ablage-Speicher bisher
selbst auf jeden Wert hochdrehen. Sie darf weiterhin ihren eigenen, kleineren
Wert wählen — beim Speichern wird er auf diese Grenze geklemmt.

Beachte: ``guilds.attachment_storage_quota_bytes`` zählt NUR Chat-Anhänge;
die Ablage hatte immer schon ihren eigenen Topf. Das bleibt so — die zwei
Grenzen sind unabhängig.

Bewusst zweistufig, wie beim Plugin-System (Instanz-Allowlist + Pro-Guild-
Toggle):

  Betreiber erlaubt (dieses Feld)  →  Community-Admin nutzt oder nicht
                                      (``dropbox_configs.enabled``, MANAGE_GUILD)

Das vorhandene ``dropbox_configs.enabled`` allein reicht nicht: es hängt an
MANAGE_GUILD, ein Community-Owner könnte ein Verbot also selbst zurückdrehen
— genau das, was ``owner.py::set_community_limits`` für die übrigen Caps
ausschließt.

Default ``false``, auch für Bestand: die Ablage nimmt beliebige Dateitypen,
für die es keinen Scan gibt (siehe docs/medien-speicher-und-scanning.md), also
gilt derselbe Geist wie bei ``allow_guild_creation`` — erst freischalten, dann
nutzen. Wirkt auf Cloud UND Self-Host: auf einem Self-Host ist der Betreiber
sein eigener Instanz-Admin und schaltet seine Communities selbst frei.

Revision ID: 0056_guild_dropbox_allowed
Revises: 0055_instance_voice_cap
Create Date: 2026-07-23 17:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0056_guild_dropbox_allowed"
down_revision: str | None = "0055_instance_voice_cap"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "guilds",
        sa.Column(
            "dropbox_allowed", sa.Boolean(), server_default="false", nullable=False
        ),
        schema=SCHEMA,
    )
    # Nullable: NULL = Instanz-Standard (1 GiB). Kein server_default, damit
    # "nie angefasst" und "bewusst auf 1 GiB gesetzt" unterscheidbar bleiben —
    # dieselbe Semantik wie bei den übrigen Boost-Caps aus 0052/0053/0054.
    op.add_column(
        "guilds",
        sa.Column("dropbox_quota_bytes", sa.BigInteger(), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("guilds", "dropbox_quota_bytes", schema=SCHEMA)
    op.drop_column("guilds", "dropbox_allowed", schema=SCHEMA)
