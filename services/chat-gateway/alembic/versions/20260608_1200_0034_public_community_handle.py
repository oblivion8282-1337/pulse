"""public community address: guilds.is_public + guilds.handle (Stufe 4)

Adds the two columns that back a community's public vanity address
(``<host>/c/<handle>``):

* ``guilds.is_public`` — Boolean NOT NULL DEFAULT false. The gate that makes
  the address resolve (preview + public join). A community is private by
  default.
* ``guilds.handle`` — String(32) NULLABLE. The stable vanity slug. Validated
  for format in the app (3–32 lowercase-slug); **unique per instance** via a
  partial unique index (only over non-NULL handles, so the many handle-less
  communities don't collide).

Reversible + single-head (Revises 0033). No data migration: every existing
guild starts private with a NULL handle, which is exactly the desired default.

Revision ID: 0034_public_community_handle
Revises: 0033_community_invites
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0034_public_community_handle"
down_revision = "0033_community_invites"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "guilds",
        sa.Column(
            "is_public",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        schema=SCHEMA,
    )
    op.add_column(
        "guilds",
        sa.Column("handle", sa.String(32), nullable=True),
        schema=SCHEMA,
    )
    # Per-instance handle uniqueness. Partial (WHERE handle IS NOT NULL) so the
    # NULL handles of private/un-addressed communities are unconstrained.
    op.create_index(
        "uq_guilds_handle",
        "guilds",
        ["handle"],
        unique=True,
        schema=SCHEMA,
        postgresql_where=sa.text("handle IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_guilds_handle", "guilds", schema=SCHEMA)
    op.drop_column("guilds", "handle", schema=SCHEMA)
    op.drop_column("guilds", "is_public", schema=SCHEMA)
