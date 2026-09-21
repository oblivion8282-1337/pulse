"""uq_users_username_lower — Fallkollisionen auf DB-Ebene ausgeschlossen

Die Registrierung reserviert Benutzernamen case-insensitiv (Vorabchecks
seit Bughunt Runde 1), aber das war check-then-act: zwei gleichzeitige
Registrierungen von „micha“ und „Micha“ gewannen beide die Prüfung — der
eindeutige (user-exact)-Constraint sah zwei VERSCHIEDENE Strings und liess
beide durch. Der eindeutige lower()-Index (Bughunt-Entscheidung 2.2,
2026-09-21 umgesetzt) ist die DB-Zährdung; /register fängt den
IntegrityError und antwortet wie beim gewöhnlichen Konflikt mit
username_taken + Vorschlägen.

Kollisions-Bestand: eine bestehende DB, die durch das frühere Fenster
bereits Fall-Varianten desselben Namens trägt, lässt diesen Indexbau mit
einem Eindeutigkeitsverstoß FEHLSCHLAGEN — absicht, der Befund ist real.
Auflösen von Hand, z. B. den jüngeren Kollisions-Account löschen (Konto-
Purge) oder per UPDATE umbenennen, dann die Migration erneut fahren.

Revision ID: 0053_users_username_lower_unique
Revises: 0052_recovery_package
Create Date: 2026-09-21 11:00:00
"""

from __future__ import annotations

from alembic import op

revision: str = "0053_users_username_lower_unique"
down_revision: str | None = "0052_recovery_package"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    # CONCURRENTLY (kein Tabellen-Lock in Produktion); Alembics implizite
    # Transaktion vorher beenden, siehe Migration 0024.
    op.execute("COMMIT")
    op.execute(
        "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_users_username_lower "
        "ON auth.users (LOWER(username))"
    )


def downgrade() -> None:
    op.execute("DROP INDEX CONCURRENTLY IF EXISTS auth.uq_users_username_lower")
