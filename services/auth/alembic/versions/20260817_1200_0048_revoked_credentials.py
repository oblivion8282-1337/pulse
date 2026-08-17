"""Grabstein-Tabelle fuer widerrufene Geraete-Zertifikate.

Der Widerruf lebte bisher ausschliesslich in ``issued_credentials.revoked_at``.
Diese Zeile haengt aber per ``ON DELETE CASCADE`` an ``users`` — mit dem Konto
verschwindet sie, und mit ihr die ``cert_id``. Danach ist der Widerruf nicht
bloss ungeschrieben, sondern begrifflich unmoeglich: die veroeffentlichte
Sperrliste kann nichts nennen, dessen Kennung niemand mehr kennt, und ein
Self-Host prueft ein Zertifikat nur gegen Signatur und Sperrliste.

``auth.revoked_credentials`` haengt an keinem Fremdschluessel und ueberlebt die
Kaskade. Sie traegt absichtlich weder ``user_id`` noch ``device_pubkey``: das
Loeschversprechen bleibt hart, und ``cert_id`` ist ein zufaelliges uuid4 ohne
Bezug zum Konto — verknuepfbar wird dadurch nichts, was ein Self-Host nicht
ohnehin aus dem vorgezeigten Zertifikat liest.

Aufbewahrung bis ``expires_at``, also genau die Restlaufzeit des Zertifikats;
der Sweeper in ``cleanup.py`` raeumt keine Sekunde frueher.

Der Backfill zieht alle bereits widerrufenen, noch nicht abgelaufenen Zeilen
mit. Er ist wiederholbar (``ON CONFLICT DO NOTHING``) und laeuft auch auf einer
Datenbank ohne einen einzigen Widerruf durch.

Revision ID: 0048_revoked_credentials
Revises: 0047_diagnose_bericht
Create Date: 2026-08-17 12:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0048_revoked_credentials"
down_revision: str | None = "0047_diagnose_bericht"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.create_table(
        "revoked_credentials",
        sa.Column("cert_id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "revoked_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("reason", sa.Text(), nullable=True),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_revoked_credentials_expires_at",
        "revoked_credentials",
        ["expires_at"],
        schema=SCHEMA,
    )
    # Backfill: was heute widerrufen und noch nicht abgelaufen ist, bekommt
    # seinen Grabstein. Ohne diesen Schritt verloeren genau die Widerrufe ihre
    # Dauerhaftigkeit, die vor dieser Migration ausgesprochen wurden.
    op.execute(
        f"""
        INSERT INTO {SCHEMA}.revoked_credentials (cert_id, expires_at, revoked_at, reason)
        SELECT cert_id, expires_at, revoked_at, 'backfill_0048'
          FROM {SCHEMA}.issued_credentials
         WHERE revoked_at IS NOT NULL
           AND expires_at > CURRENT_TIMESTAMP
        ON CONFLICT (cert_id) DO NOTHING
        """
    )


def downgrade() -> None:
    # Der Rueckbau verliert jeden Widerruf zu einem bereits geloeschten Konto —
    # unvermeidlich, denn genau die traegt keine andere Zeile mehr.
    op.drop_index(
        "ix_revoked_credentials_expires_at", "revoked_credentials", schema=SCHEMA
    )
    op.drop_table("revoked_credentials", schema=SCHEMA)
