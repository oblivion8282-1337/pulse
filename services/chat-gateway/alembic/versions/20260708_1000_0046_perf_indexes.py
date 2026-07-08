"""perf_indexes — drei Lookup-Indexe gegen Worst-Case-Scans

Schließt Lücken, die bei Wachstum / Account-Löschung zu Full-Table-Scans
führen (siehe Performance-Audit 2026-07-08):

- ``messages.author_id``: der Purge-Pfad (``DELETE WHERE author_id = :uid``)
  scannt sonst die größte Tabelle der Schema komplett. ``messages`` hat zwar
  ``(channel_id, id)``, aber keinen Author-Index.
- ``message_reactions.user_id``: liegt mittig im Composite-PK
  ``(message_id, user_id, emoji)`` und kann daher eine ``user_id``-Leading-
  Lookup nicht bedienen — Purge scannt sonst die ganze Reactions-Tabelle.
- ``member_roles (guild_id, role_id)``: der Large-Guild-VIEW_CHANNEL-Pfad
  resolvt ``WHERE guild_id = :g AND role_id IN (...)``; die bestehenden
  Indexe führen mit ``(guild_id, user_id)`` und können das nicht bedienen.

CONCURRENTLY vermeidet einen Full-Table-Lock in Produktion (analog
``0024_users_lower_indexes`` im auth-svc).

Revision ID: 0046_perf_indexes
Revises: 0045_channel_voice_pulls
Create Date: 2026-07-08 10:00:00
"""

from __future__ import annotations

from alembic import op

revision: str = "0046_perf_indexes"
down_revision: str | None = "0045_channel_voice_pulls"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    # CONCURRENTLY kann nicht in einer Transaktion laufen — Alembic öffnet
    # implizit eine, also zuerst committen (siehe auth 0024-Vorbild).
    op.execute("COMMIT")
    op.execute(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_messages_author "
        f"ON {SCHEMA}.messages (author_id)"
    )
    op.execute(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_message_reactions_user "
        f"ON {SCHEMA}.message_reactions (user_id)"
    )
    op.execute(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_member_roles_role "
        f"ON {SCHEMA}.member_roles (guild_id, role_id)"
    )


def downgrade() -> None:
    op.execute(f"DROP INDEX IF EXISTS {SCHEMA}.ix_member_roles_role")
    op.execute(f"DROP INDEX IF EXISTS {SCHEMA}.ix_message_reactions_user")
    op.execute(f"DROP INDEX IF EXISTS {SCHEMA}.ix_messages_author")
