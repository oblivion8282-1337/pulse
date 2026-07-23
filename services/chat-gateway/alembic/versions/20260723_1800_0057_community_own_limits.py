"""guilds: eigene Werte der Community neben den Grenzen des Betreibers

Bisher gab es pro Limit genau eine Spalte, und wer sie schreiben durfte, war
je nach Limit verschieden — bei ``attachment_max_size_bytes`` schrieben sogar
BEIDE Ebenen dieselbe Zelle (``GuildPatchIn`` mit MANAGE_GUILD und der
Owner-Endpoint), womit die Community die Vorgabe des Betreibers überschreiben
konnte.

Ab hier gilt durchgängig dasselbe Modell, wie es die Ablage-Quota in 0056
eingeführt hat:

    Betreiber-Obergrenze   ──klemmt──▶   Wert der Community   ──▶  wirksam

* Die Obergrenze setzt NUR ``/owner/communities/{id}/limits``.
* Den Wert setzt die Community-Leitung (MANAGE_GUILD) und darf dabei unter,
  aber nie über die Obergrenze.
* NULL heißt auf beiden Ebenen „nicht gesetzt": oben der Instanz-Standard,
  unten „nimm die Obergrenze".

Die vorhandenen Spalten bleiben Obergrenzen — mit zwei Ausnahmen, bei denen
die vorhandene Spalte inhaltlich der Wert der Community ist (sie wird an der
Upload-Schranke gelesen und war schon immer MANAGE_GUILD-editierbar):
``attachment_max_size_bytes`` und ``attachment_max_count_per_message``. Für
die kommt die Obergrenze neu dazu, nicht der Wert.

Revision ID: 0057_community_own_limits
Revises: 0056_guild_dropbox_allowed
Create Date: 2026-07-23 18:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0057_community_own_limits"
down_revision: str | None = "0056_guild_dropbox_allowed"
branch_labels = None
depends_on = None

SCHEMA = "chat"

# (Spaltenname, Typ) — alle nullable, siehe Modul-Docstring.
_COMMUNITY_VALUES = [
    ("community_voice_bitrate_kbps", sa.SmallInteger()),
    ("community_stream_bitrate_kbps", sa.Integer()),
    ("community_stream_fps", sa.SmallInteger()),
    ("community_stream_resolution", sa.String(16)),
    ("community_max_members", sa.Integer()),
    ("community_max_channels", sa.SmallInteger()),
    ("community_max_roles", sa.SmallInteger()),
    ("community_max_concurrent_streams", sa.SmallInteger()),
    ("community_attachment_storage_quota_bytes", sa.BigInteger()),
]

# Gegenstück: Obergrenzen für die zwei Limits, deren vorhandene Spalte bereits
# der Wert der Community ist.
_OPERATOR_CEILINGS = [
    ("attachment_max_size_ceiling_bytes", sa.BigInteger()),
    ("attachment_max_count_ceiling", sa.SmallInteger()),
]


def upgrade() -> None:
    for name, type_ in _COMMUNITY_VALUES + _OPERATOR_CEILINGS:
        op.add_column(
            "guilds", sa.Column(name, type_, nullable=True), schema=SCHEMA
        )


def downgrade() -> None:
    for name, _type in reversed(_COMMUNITY_VALUES + _OPERATOR_CEILINGS):
        op.drop_column("guilds", name, schema=SCHEMA)
