"""Verknuepfung zwischen Refresh-Token und Browser-Session-Cookie.

Eine "Sitzung" ist im Auth-Dienst zweigeteilt: der Refresh-Token
(``auth.refresh_tokens``) und das ``pulse_session``-Cookie
(``auth.user_sessions``). Beide entstehen im selben Anmeldevorgang, lebten aber
ohne jede Verbindung nebeneinander. Der Einzel-Widerruf unter ``/sessions``
kannte nur die Refresh-Token-Zeile — das Geraet blieb ueber sein Cookie voll
angemeldet und konnte weiter Geraete-Zertifikate ausstellen
(``/credentials/issue`` authentifiziert ausschliesslich ueber das Cookie).
Die Oberflaeche sagt an dieser Stelle "Sitzung beenden" zu; die Zusage war
nur zur Haelfte eingeloest.

``session_id`` traegt die Verbindung. ``ON DELETE SET NULL``, weil der Sweeper
abgelaufene Cookie-Zeilen loescht: die Verknuepfung faellt dann weg, und das
ist richtig so — an einem abgelaufenen Cookie ist nichts mehr zu beenden.

Kein Backfill: die Zuordnung alter Zeilen liesse sich nur raten (gleiche
IP-Pruefsumme, gleicher Browser-Kennstring), und ein falsch geratener Bezug
beendete die Sitzung eines fremden Geraets desselben Nutzers. Bestehende
Refresh-Token bleiben deshalb unverknuepft; ``routes_sessions`` faengt sie
ueber einen ausdruecklich als Notbehelf gekennzeichneten Vergleichsweg ab, und
mit dem naechsten ``/refresh`` erbt ohnehin keine Zeile mehr die Luecke — die
Verknuepfung entsteht bei jeder Neuanmeldung.

Revision ID: 0049_refresh_token_session_link
Revises: 0048_revoked_credentials
Create Date: 2026-08-18 12:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0049_refresh_token_session_link"
down_revision: str | None = "0048_revoked_credentials"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.add_column(
        "refresh_tokens",
        sa.Column("session_id", postgresql.UUID(as_uuid=True), nullable=True),
        schema=SCHEMA,
    )
    op.create_foreign_key(
        "fk_refresh_tokens_session_id",
        "refresh_tokens",
        "user_sessions",
        ["session_id"],
        ["session_id"],
        source_schema=SCHEMA,
        referent_schema=SCHEMA,
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_refresh_tokens_session_id",
        "refresh_tokens",
        ["session_id"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_refresh_tokens_session_id", "refresh_tokens", schema=SCHEMA)
    op.drop_constraint(
        "fk_refresh_tokens_session_id",
        "refresh_tokens",
        schema=SCHEMA,
        type_="foreignkey",
    )
    op.drop_column("refresh_tokens", "session_id", schema=SCHEMA)
