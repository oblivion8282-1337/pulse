"""registered_instances.env_file_downloaded_at — One-Shot-Markierung

Trackt, ob ``POST /me/instances/{id}/env-file`` für die Instanz bereits
aufgerufen wurde (NULL → Download erlaubt, NOT NULL → 403). Sperrt die
Secret-Rotation als Side-Channel zum Bootstrap-Token-One-Shot ab — siehe
``routes_instance_applications.generate_env_file``.

NULL als Default, damit Bestands-Instanzen weiter downloaden können;
neue Werte setzt ausschließlich der Endpoint.

Revision ID: 0036_env_file_one_shot
Revises: 0035_app_host_applications
Create Date: 2026-06-28 12:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0036_env_file_one_shot"
down_revision: str | None = "0035_app_host_applications"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.add_column(
        "registered_instances",
        sa.Column(
            "env_file_downloaded_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("registered_instances", "env_file_downloaded_at", schema=SCHEMA)