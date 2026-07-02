"""registered_instances.origin — vps | app_host

App-Host-Instanzen (Ein-Knopf-Container aus der Desktop-App) sollen nicht in
der VPS-"Meine Instanzen"-Liste mit "Server einrichten"-Flow auftauchen und
umgekehrt soll die App-Hosting-Karte nur echte App-Host-Instanzen anbieten.
Explizites Herkunfts-Feld statt Hostname-Heuristik — robust, falls später
auch VPS-Instanzen einen Relay nutzen dürfen.

Backfill: bestehende App-Host-Instanzen sind an ihrem synthetischen Hostname
``app-<snowflake>.<relay_base>`` erkennbar (instance_provisioning.py).

Revision ID: 0040_instances_origin
Revises: 0039_users_is_owner
Create Date: 2026-07-02 11:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0040_instances_origin"
down_revision: str | None = "0039_users_is_owner"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.add_column(
        "registered_instances",
        sa.Column(
            "origin",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'vps'"),
        ),
        schema=SCHEMA,
    )
    # Bestandsdaten: synthetische App-Host-Hostnames (app-<nur-Ziffern>.…)
    # umflaggen. VPS-Hostnames sind user-gewählte echte Domains.
    op.execute(
        sa.text(
            r"""
            UPDATE auth.registered_instances SET origin = 'app_host'
            WHERE hostname ~ '^app-[0-9]+\.'
            """
        )
    )


def downgrade() -> None:
    op.drop_column("registered_instances", "origin", schema=SCHEMA)
