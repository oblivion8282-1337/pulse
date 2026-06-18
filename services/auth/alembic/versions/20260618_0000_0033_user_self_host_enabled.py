from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0033_user_self_host_enabled"
down_revision: str | None = "0032_instance_relay_provisioning"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "self_host_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("users", "self_host_enabled", schema=SCHEMA)
