"""user_pairwise_salt, revoke_until, is_suspended — Cert-Modell-Fundament

Adds three columns to ``auth.users`` required by DE 11 (Identitäts-Cert-
Modell) and the Account-Suspension / Race-Protection design (DE 11 A.4 +
A.11 + Review #4):

``pairwise_salt`` — 32 random bytes generated server-side.  Used in every
Identitäts-Cert issued for this user: ``pairwise_seed = pairwise_salt`` is
embedded in the JWT so that Self-Hosts can compute a consistent, instance-
scoped pseudonymous subject via ``hash(user_id, instance_id, pairwise_seed)``
across all devices of the same user (DE 11 A.4).  The value is per-USER, not
per-Cert, so multi-device works without coordination.

``revoke_until`` — nullable TIMESTAMPTZ.  Set to ``now()`` on Logout-
Everywhere / Admin-Suspend; ``POST /credentials/issue`` blocks re-issuance
while ``now() < revoke_until + 5 min`` (Race-Condition-Schutz, Review #4
point 18+19).  Cleared on the next successful MFA-Login.

``is_suspended`` — boolean admin flag.  When true the account cannot log in
at all (Admin-Force-Suspension, DE 11 A.11).  Checked in ``/login`` before
password verification.

Revision ID: 0012_user_pairwise_salt
Revises: 0011_users_discoverable
Create Date: 2026-05-25 00:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision: str = "0012_user_pairwise_salt"
down_revision: str | None = "0011_users_discoverable"
branch_labels = None
depends_on = None

SCHEMA = "auth"

# ``gen_random_bytes`` lives in the ``pgcrypto`` extension (Postgres 13+).
# We enable it here so the migration is self-contained; the extension is
# idempotent (IF NOT EXISTS) and safe to run even if already present.
# SQLite tests use ``Base.metadata.create_all`` (not Alembic upgrade), so
# this path never executes in the test backend.
_PAIRWISE_SALT_DEFAULT = sa.text("gen_random_bytes(32)")


def upgrade() -> None:
    # Activate pgcrypto for gen_random_bytes — idempotent.
    op.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")

    op.add_column(
        "users",
        sa.Column(
            "pairwise_salt",
            sa.LargeBinary(),
            nullable=False,
            server_default=_PAIRWISE_SALT_DEFAULT,
        ),
        schema=SCHEMA,
    )
    op.add_column(
        "users",
        sa.Column(
            "revoke_until",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        schema=SCHEMA,
    )
    op.add_column(
        "users",
        sa.Column(
            "is_suspended",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        schema=SCHEMA,
    )
    # Remove the server_default after backfill so future INSERT paths must
    # supply an explicit value (forces callers to think about it).
    op.alter_column("users", "pairwise_salt", server_default=None, schema=SCHEMA)


def downgrade() -> None:
    op.drop_column("users", "is_suspended", schema=SCHEMA)
    op.drop_column("users", "revoke_until", schema=SCHEMA)
    op.drop_column("users", "pairwise_salt", schema=SCHEMA)
