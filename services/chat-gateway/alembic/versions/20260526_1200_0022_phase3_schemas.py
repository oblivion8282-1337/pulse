"""Phase 3.1 — cached_user_profiles, reports, mod_audit_log.

Three new tables for Self-Host Phase 3:

* ``cached_user_profiles`` — Cross-mode profile cache (Cloud user_id or
  Self-Host pairwise-sub), replay-protection via ``last_statement_iat``.
* ``reports`` — Moderation reports: message / user / channel targets with
  status lifecycle (new → triaged → resolved / dismissed).
* ``mod_audit_log`` — Append-only moderation audit trail, guild-scoped,
  indexed for per-guild and per-actor timeline queries.

No foreign keys to ``auth.users`` (cross-service boundary).  All IDs that
reference users are raw ``BIGINT`` / ``TEXT`` columns.

Revision ID: 0022_phase3_schemas
Revises: 0021_guild_plugin_state
Create Date: 2026-05-26 12:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0022_phase3_schemas"
down_revision: str | None = "0021_guild_plugin_state"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    # ------------------------------------------------------------------
    # 1. cached_user_profiles
    # ------------------------------------------------------------------
    op.create_table(
        "cached_user_profiles",
        # Cloud-mode: numeric user_id as string; Self-Host: pairwise-sub (16 chars)
        sa.Column("user_identifier", sa.Text(), nullable=False),
        sa.Column("username", sa.Text(), nullable=False),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column("avatar_hash", sa.Text(), nullable=True),
        sa.Column("profile_color", sa.Text(), nullable=True),
        # last_statement_iat: iat from the most recently accepted profile
        # statement — used for replay-protection (DE 11 A.3).
        sa.Column("last_statement_iat", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "stale",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.PrimaryKeyConstraint("user_identifier", name="pk_cached_user_profiles"),
        schema=SCHEMA,
    )
    # Username index — used for mention-search (@ autocomplete)
    op.create_index(
        "ix_cached_user_profiles_username",
        "cached_user_profiles",
        ["username"],
        schema=SCHEMA,
    )

    # ------------------------------------------------------------------
    # 2. reports
    # ------------------------------------------------------------------
    op.create_table(
        "reports",
        sa.Column("id", sa.BigInteger(), nullable=False),           # Snowflake PK
        sa.Column("reporter_user_id", sa.BigInteger(), nullable=False),
        sa.Column("target_message_id", sa.BigInteger(), nullable=True),
        sa.Column("target_user_id", sa.BigInteger(), nullable=True),
        sa.Column("target_channel_id", sa.BigInteger(), nullable=True),
        # reason_code: spam | harassment | illegal | csam | other
        sa.Column("reason_code", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        # status: new | triaged | resolved | dismissed
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'new'"),
        ),
        sa.Column("resolver_user_id", sa.BigInteger(), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolution_note", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_reports"),
        schema=SCHEMA,
    )
    # Composite index for mod-queue listing (ordered by status + time)
    op.create_index(
        "ix_reports_status_created",
        "reports",
        ["status", "created_at"],
        schema=SCHEMA,
    )

    # ------------------------------------------------------------------
    # 3. mod_audit_log
    # ------------------------------------------------------------------
    op.create_table(
        "mod_audit_log",
        sa.Column("id", sa.BigInteger(), nullable=False),           # Snowflake PK
        sa.Column("guild_id", sa.BigInteger(), nullable=False),
        sa.Column("actor_user_id", sa.BigInteger(), nullable=False),
        # action_type: permission_change | ban | message_delete |
        #              report_resolution | role_change | etc.
        sa.Column("action_type", sa.Text(), nullable=False),
        # target_kind: user | channel | role | message
        sa.Column("target_kind", sa.Text(), nullable=True),
        sa.Column("target_id", sa.BigInteger(), nullable=True),
        sa.Column(
            "payload",
            sa.JSON().with_variant(postgresql.JSONB(), "postgresql"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_mod_audit_log"),
        schema=SCHEMA,
    )
    # Per-guild timeline query (most recent first)
    op.create_index(
        "ix_mod_audit_log_guild_created",
        "mod_audit_log",
        ["guild_id", sa.text("created_at DESC")],
        schema=SCHEMA,
    )
    # Per-actor timeline query
    op.create_index(
        "ix_mod_audit_log_actor_created",
        "mod_audit_log",
        ["actor_user_id", sa.text("created_at DESC")],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_mod_audit_log_actor_created", "mod_audit_log", schema=SCHEMA)
    op.drop_index("ix_mod_audit_log_guild_created", "mod_audit_log", schema=SCHEMA)
    op.drop_table("mod_audit_log", schema=SCHEMA)

    op.drop_index("ix_reports_status_created", "reports", schema=SCHEMA)
    op.drop_table("reports", schema=SCHEMA)

    op.drop_index("ix_cached_user_profiles_username", "cached_user_profiles", schema=SCHEMA)
    op.drop_table("cached_user_profiles", schema=SCHEMA)
