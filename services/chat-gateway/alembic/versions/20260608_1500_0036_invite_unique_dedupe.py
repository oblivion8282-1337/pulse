"""community-invites: unique dedupe index (race-safe broker)

Promotes ``ix_community_invites_dedupe`` from a plain index to a UNIQUE one so
the invite-broker's "one inviter → one invitee → one guild" dedupe is enforced
by the DB instead of a read-then-write in application code. Two near-simultaneous
POSTs (a double-clicked "invite" button) could otherwise each insert a row and
stack two "Beitreten"-Karten; the unique index now rejects the loser's INSERT
(the route catches the IntegrityError and resolves to the winner's row).

Defensive de-dupe first: should any duplicate triples already exist (older code
path), keep the highest ``id`` per triple (snowflake ids are time-ordered, so
that's the newest) and delete the rest, otherwise the unique index can't be
created.

Revision ID: 0036_invite_unique_dedupe
Revises: 0035_instance_locked_toggle

NB: the revision id is kept short — ``alembic_version.version_num`` is
``varchar(32)``, so a longer id fails the post-migration version bookkeeping
(``value too long``) and, under Postgres transactional DDL, rolls the whole
migration back.
"""

from __future__ import annotations

from alembic import op

revision = "0036_invite_unique_dedupe"
down_revision = "0035_instance_locked_toggle"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    # Drop any pre-existing duplicate triples (keep the newest = highest id).
    op.execute(
        f"""
        DELETE FROM {SCHEMA}.community_invites a
        USING {SCHEMA}.community_invites b
        WHERE a.inviter_id = b.inviter_id
          AND a.invitee_id = b.invitee_id
          AND a.target_guild_id = b.target_guild_id
          AND a.id < b.id
        """
    )
    op.drop_index(
        "ix_community_invites_dedupe", "community_invites", schema=SCHEMA
    )
    op.create_index(
        "ix_community_invites_dedupe",
        "community_invites",
        ["inviter_id", "invitee_id", "target_guild_id"],
        unique=True,
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_community_invites_dedupe", "community_invites", schema=SCHEMA
    )
    op.create_index(
        "ix_community_invites_dedupe",
        "community_invites",
        ["inviter_id", "invitee_id", "target_guild_id"],
        schema=SCHEMA,
    )
