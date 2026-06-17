from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0032_instance_relay_provisioning"
down_revision: str | None = "0031_profile_gradient_angle"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.add_column(
        "registered_instances",
        sa.Column("relay_subdomain", sa.Text(), nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        "registered_instances",
        sa.Column("relay_tunnel_token_hash", sa.Text(), nullable=True),
        schema=SCHEMA,
    )
    op.create_index(
        "uq_registered_instances_relay_subdomain",
        "registered_instances",
        ["relay_subdomain"],
        unique=True,
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index(
        "uq_registered_instances_relay_subdomain",
        table_name="registered_instances",
        schema=SCHEMA,
    )
    op.drop_column("registered_instances", "relay_tunnel_token_hash", schema=SCHEMA)
    op.drop_column("registered_instances", "relay_subdomain", schema=SCHEMA)
