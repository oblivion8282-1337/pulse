"""cached_user_profiles — funktionaler Index auf lower(username)

Perf-Hunt 06.10.: Mention-Autocomplete sucht per ``lower(username) LIKE
'q%'`` (routes/mention_search.py, Bughunt Runde 23 — Groß-/klein gemischt).
Der bestehende ``ix_cached_user_profiles_username`` liegt auf dem rohen
Namen, darum konnte Postgres ihn für den lower()-Ausdruck nicht nutzen
(Seq-Scan über die Profil-Caches). Der funktionale Index deckt genau den
Präfix-Pfad ab; der alte Index bleibt für die case-sensitiven Leser stehen.

Revision ID: 0100_cached_user_profiles_lower
Revises: 0099_gruppen_lesestand
Create Date: 2026-10-06 10:00:00.000000+00:00

"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# Siehe 0088: die Tabellen dieses Dienstes leben im Schema ``chat``.
SCHEMA = "chat"

revision: str = "0100_cached_user_profiles_lower"
down_revision: str | Sequence[str] | None = "0099_gruppen_lesestand"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index(
        "ix_cached_user_profiles_username_lower",
        "cached_user_profiles",
        [sa.text("lower(username)")],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_cached_user_profiles_username_lower",
        table_name="cached_user_profiles",
        schema=SCHEMA,
    )
