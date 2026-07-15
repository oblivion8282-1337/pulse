"""Report → guild scoping helpers for the mod-queue.

A report can reference a channel, a message and/or a user; deciding which
guild(s) it belongs to is shared by several call sites with different return
shapes:

  * :func:`_guild_scope_predicate` — SQL OR-clause for list/count queries.
  * :func:`_report_in_guild` — bool guard for a single guild (resolve/triage).
  * :func:`guilds_for_report` — the full guild set (report-creation push).

Kept in one module so the three mirrors of the same scoping rule stay
together — they must not diverge (see the divergence note on
``_report_in_guild``).
"""

from __future__ import annotations

from sqlalchemy import or_, select

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import Channel, GuildMember, Message, Report


def _guild_scope_predicate(guild_id: int):
    """The OR-clause that scopes a report to ``guild_id``.

    A report is in scope when *any* of its targets belongs to this guild:
      - target_channel_id → channel's guild_id matches
      - target_message_id → message's channel's guild_id matches
      - target_guild_id → explicit community scope (member-list user report)
      - target_user_id only (no channel/message/guild target) → user is a
        member (legacy fan-out for reports raised without a guild context)

    Shared by ``list_mod_queue`` and ``mod_queue_count`` so the badge count
    can never drift from the list the moderator actually sees.
    """
    channel_ids_in_guild = (
        select(Channel.id).where(Channel.guild_id == guild_id).scalar_subquery()
    )
    msg_ids_in_guild = (
        select(Message.id)
        .join(Channel, Channel.id == Message.channel_id)
        .where(Channel.guild_id == guild_id)
        .scalar_subquery()
    )
    member_user_ids = (
        select(GuildMember.user_id).where(GuildMember.guild_id == guild_id).scalar_subquery()
    )
    return or_(
        Report.target_channel_id.in_(channel_ids_in_guild),
        Report.target_message_id.in_(msg_ids_in_guild),
        Report.target_guild_id == guild_id,
        (
            Report.target_user_id.in_(member_user_ids)
            & Report.target_channel_id.is_(None)
            & Report.target_message_id.is_(None)
            & Report.target_guild_id.is_(None)
        ),
    )


async def guilds_for_report(session: SessionDep, report: Report) -> set[int]:
    """Every ``guild_id`` this report is in scope for.

    Mirrors ``_report_in_guild`` / ``_guild_scope_predicate`` but returns the
    full set: a report can belong to several guilds (a user-only report against
    a member of many guilds, or targets pointing at different guilds). Used at
    report-creation time to push ``report_new`` to each affected guild's
    moderators.
    """
    guilds: set[int] = set()

    if report.target_channel_id is not None:
        gid = await session.scalar(
            select(Channel.guild_id).where(Channel.id == report.target_channel_id)
        )
        if gid is not None:
            guilds.add(gid)

    if report.target_message_id is not None:
        gid = await session.scalar(
            select(Channel.guild_id)
            .join(Message, Message.channel_id == Channel.id)
            .where(Message.id == report.target_message_id)
        )
        if gid is not None:
            guilds.add(gid)

    if report.target_guild_id is not None:
        guilds.add(report.target_guild_id)

    # user-only report WITHOUT an explicit guild scope → every guild the target
    # is a member of, mirroring the list-query's user-only branch. When
    # target_guild_id is set (member-list report), the branch above already
    # pinned it to that one community — no fan-out.
    if (
        report.target_user_id is not None
        and report.target_channel_id is None
        and report.target_message_id is None
        and report.target_guild_id is None
    ):
        rows = await session.execute(
            select(GuildMember.guild_id).where(
                GuildMember.user_id == report.target_user_id
            )
        )
        guilds.update(rows.scalars())

    return guilds


async def _report_in_guild(session: SessionDep, report: Report, guild_id: int) -> bool:
    """True iff *any* of the report's targets belongs to ``guild_id``.

    Mirrors the OR-predicate in ``list_mod_queue``: checks every non-None target
    independently and returns True as soon as one of them scopes to the guild.
    Using an early-return chain (if channel → return) would cause divergence when
    a report has both target_channel_id *and* target_message_id pointing to
    different guilds — the list query would include the report for both guilds but
    the old guard would only check the first field.
    """
    if report.target_channel_id is not None:
        gid = await session.scalar(
            select(Channel.guild_id).where(Channel.id == report.target_channel_id)
        )
        if gid == guild_id:
            return True

    if report.target_message_id is not None:
        gid = await session.scalar(
            select(Channel.guild_id)
            .join(Message, Message.channel_id == Channel.id)
            .where(Message.id == report.target_message_id)
        )
        if gid == guild_id:
            return True

    if report.target_guild_id == guild_id:
        return True

    # user-only check: mirrors the `target_channel_id IS NULL AND
    # target_message_id IS NULL AND target_guild_id IS NULL` guard from
    # list_mod_queue — avoids treating a cross-guild report (channel→guild A,
    # user in guild B) as guild-B-scoped via the user branch alone, and skips
    # the fan-out entirely once an explicit guild scope is present.
    if (
        report.target_user_id is not None
        and report.target_channel_id is None
        and report.target_message_id is None
        and report.target_guild_id is None
    ):
        member = await session.scalar(
            select(GuildMember.user_id).where(
                GuildMember.guild_id == guild_id,
                GuildMember.user_id == report.target_user_id,
            )
        )
        if member is not None:
            return True

    return False
