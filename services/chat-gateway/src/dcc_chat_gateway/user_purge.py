"""User-account purge orchestration — called by auth-svc when a user
self-deletes their account.

Hard-delete (not anonymize). Owner-of-guild → guild gets nuked with it
(Discord-style "owner leaves" semantics; UI can offer an
owner-transfer dance *before* the user reaches this endpoint).

All DB work happens inside a single SQLAlchemy transaction so a half-
purge can't leave dangling rows. Everything that is NOT a DB row —
Redis presence keys, a still-connected LiveKit session, dropbox MinIO
objects, the in-process device register — is best-effort and runs
*after* the DB commit (see ``_PurgeResult``): a rollback must not leave
someone evicted or a MinIO object gone while the rows still exist. Most
of it self-heals eventually anyway; this just avoids waiting for the
next poll/webhook tick.

Importable for tests; the route in ``routes/internal.py`` is a thin
auth-+-glue wrapper around ``purge_user``.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import delete as sa_delete
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.device_meldungen import device_out
from dcc_chat_gateway.models import (
    MENTION_TYPE_USER,
    Channel,
    CommunityInvite,
    Device,
    DirectMessageChannel,
    FriendRequest,
    Friendship,
    Guild,
    GuildBan,
    GuildMember,
    MemberRole,
    Message,
    MessageAttachment,
    MessageMention,
    MessageReaction,
    PermissionOverwrite,
    Report,
    UserBlock,
    UserPreference,
    UserPrivacy,
    WebPushSubscription,
)
from dcc_chat_gateway.routes.attachments import hard_delete_attachments
from dcc_chat_gateway.routes.dropbox_admin import purge_guild_dropbox_objects
from dcc_chat_gateway.user_purge_ablage import (
    purge_ablage_konto_laufwerk,
    purge_ablage_zwischenlager,
)
from dcc_chat_gateway.user_purge_gruppen import purge_private_group_memberships
from dcc_chat_gateway.user_purge_kopplung import purge_kopplung
from dcc_chat_gateway.user_purge_nachlauf import evict_voice_sessions, forget_devices
from dcc_chat_gateway.user_purge_postfach import purge_postfach
from dcc_chat_gateway.voice_evict import voice_channels_for_guild

if TYPE_CHECKING:
    from dcc_chat_gateway.pubsub import ConnectionManager

log = logging.getLogger(__name__)

# Endstatus für Meldungen, die der Purge selbst schliesst (Report.status
# kennt nur "resolved"/"dismissed" als Endzustaende, s. routes/mod_queue.py).
_REPORT_STATUS_OBSOLETE = "dismissed"
_REPORT_NOTE_OBSOLETE = "Konto gelöscht"


@dataclass
class _PurgeResult:
    """Sammelt, was ausserhalb der DB-Transaktion nachgezogen werden muss —
    LiveKit-Eviction und Geraete-Register sind eigene Systeme, keine
    DB-Zeilen, deshalb erst NACH dem Commit angefasst (s. Modul-Docstring)."""

    #: Communitys, die komplett geloescht wurden (fuer den guild_deleted-Broadcast).
    deleted_guild_ids: list[int] = field(default_factory=list)
    #: Sprachkanaele geloeschter (eigener) Communitys — dort muss JEDER
    #: Anwesende raus, nicht nur der Geloeschte (Ghost-Room, s. guilds.py::delete_guild).
    owned_voice_channel_ids: list[int] = field(default_factory=list)
    #: Communitys, in denen der Geloeschte Mitglied war, OHNE Eigentuemer zu
    #: sein — dort bleibt der Kanal bestehen, nur der Geloeschte muss aus
    #: einer eventuell laufenden LiveKit-Sitzung.
    other_member_guild_ids: list[int] = field(default_factory=list)
    #: Standplatz-Geraete des Nutzers, vor dem Loeschen erfasst (Kennung,
    #: Community, Kanal, Aussenform) — fuers Register-Vergessen + die
    #: device_changed-Meldung nach dem Commit.
    removed_devices: list[tuple[int, int, int, dict]] = field(default_factory=list)


# permission_overwrites.target_type sentinel for user-scoped rows
# (role-scoped = 0). Mirrors the constants used by routes/permission_overwrites.
_OVERWRITE_TARGET_USER = 1


async def _collect_owned_guild_ids(session: AsyncSession, user_id: int) -> list[int]:
    stmt = select(Guild.id).where(Guild.owner_id == user_id)
    return list((await session.execute(stmt)).scalars())


async def _collect_member_guild_ids(session: AsyncSession, user_id: int) -> list[int]:
    stmt = select(GuildMember.guild_id).where(GuildMember.user_id == user_id)
    return list((await session.execute(stmt)).scalars())


async def _collect_dm_channel_ids(session: AsyncSession, user_id: int) -> list[int]:
    stmt = select(DirectMessageChannel.id).where(
        or_(
            DirectMessageChannel.user_a_id == user_id,
            DirectMessageChannel.user_b_id == user_id,
        )
    )
    return list((await session.execute(stmt)).scalars())


async def _hard_delete_guild_with_attachments(
    session: AsyncSession, guild_id: int
) -> list[int]:
    """``session.delete(guild)`` cascades channels/messages/members/etc.
    via the FK schema, but MinIO objects need an explicit sweep first
    (see ``routes/guilds.py::delete_guild`` for the same pattern).

    Returns the guild's voice-channel IDs — captured before the cascade
    removes the ``channels`` rows — so the caller can evict every LiveKit
    occupant from them AFTER the commit succeeds (mirrors
    ``routes/guilds.py::delete_guild``; without this the room keeps
    running for a channel that no longer exists)."""
    channel_ids_stmt = select(Channel.id).where(Channel.guild_id == guild_id)
    channel_ids = list((await session.execute(channel_ids_stmt)).scalars())
    voice_channel_ids = await voice_channels_for_guild(session, guild_id)
    if channel_ids:
        att_ids_stmt = select(MessageAttachment.id).where(
            MessageAttachment.channel_id.in_(channel_ids),
            MessageAttachment.deleted_at.is_(None),
        )
        att_ids = list((await session.execute(att_ids_stmt)).scalars())
        if att_ids:
            await hard_delete_attachments(session, attachment_ids=att_ids)
    guild = await session.get(Guild, guild_id)
    if guild is not None:
        await session.delete(guild)
    return voice_channel_ids


async def _delete_user_authored_messages(
    session: AsyncSession, user_id: int
) -> None:
    """Hard-delete every message the user wrote (across all channels +
    DMs). FK CASCADE on ``message_id`` clears reactions / mentions /
    attachments rows; MinIO objects need the helper sweep.

    Runs the report cleanup first (needs the still-live message IDs)."""
    msg_ids_stmt = select(Message.id).where(Message.author_id == user_id)
    msg_ids = list((await session.execute(msg_ids_stmt)).scalars())
    await _close_reports_for_deleted_user(session, user_id, msg_ids)
    if not msg_ids:
        return
    await hard_delete_attachments(session, message_ids=msg_ids)
    await session.execute(sa_delete(Message).where(Message.id.in_(msg_ids)))


async def _close_reports_for_deleted_user(
    session: AsyncSession, user_id: int, message_ids: Iterable[int]
) -> None:
    """Offene Meldungen schliessen, die auf den geloeschten Nutzer zeigen —
    direkt (``target_user_id``) oder ueber eine seiner gleich mit-geloeschten
    Nachrichten (``target_message_id``). ``Report`` traegt weder FK noch
    CASCADE auf ``messages``/Nutzer (bewusst, s. Modell-Docstring), eine
    offen bleibende Zeile faellt sonst aus jeder Warteschlange und laesst
    sich nie mehr triagieren, aufloesen oder eskalieren."""
    msg_ids = list(message_ids)
    conditions = [Report.target_user_id == user_id]
    if msg_ids:
        conditions.append(Report.target_message_id.in_(msg_ids))
    stmt = select(Report).where(
        Report.status.in_(("new", "triaged")), or_(*conditions)
    )
    reports = (await session.execute(stmt)).scalars().all()
    if not reports:
        return
    now = datetime.now(UTC)
    for report in reports:
        report.status = _REPORT_STATUS_OBSOLETE
        report.resolved_at = now
        report.resolution_note = _REPORT_NOTE_OBSOLETE
        # Zeigt sonst auf eine Zeile, die gleich hart geloescht wird.
        report.target_message_id = None


async def _delete_dm_channels(
    session: AsyncSession, dm_channel_ids: Iterable[int]
) -> None:
    """Delete every DM channel the user participated in + every message
    posted in them. DM channels are 1:1, so the other side has nobody
    left to chat with via this record anyway."""
    cids = list(dm_channel_ids)
    if not cids:
        return
    # MinIO objects on remaining messages (posted by the other party).
    att_ids_stmt = select(MessageAttachment.id).where(
        MessageAttachment.channel_id.in_(cids),
        MessageAttachment.deleted_at.is_(None),
    )
    att_ids = list((await session.execute(att_ids_stmt)).scalars())
    if att_ids:
        await hard_delete_attachments(session, attachment_ids=att_ids)
    await session.execute(sa_delete(Message).where(Message.channel_id.in_(cids)))
    await session.execute(
        sa_delete(DirectMessageChannel).where(DirectMessageChannel.id.in_(cids))
    )


async def _purge_db(
    session: AsyncSession, user_id: int, manager: ConnectionManager | None
) -> _PurgeResult:
    """Single-transaction DB sweep. Returns a :class:`_PurgeResult` with
    everything the caller must still fan out AFTER the commit (guild_deleted
    events, LiveKit eviction, device-register forgetting) — none of that is
    a DB row, so none of it belongs inside this transaction."""
    result = _PurgeResult()

    # 0. Every guild the user is CURRENTLY a member of (owned or not),
    # captured before anything below removes the membership rows or the
    # guild itself. Needed so a possibly still-connected LiveKit session
    # can be evicted after the commit — the owned half goes into
    # ``owned_voice_channel_ids`` per-guild below, the rest is "member of
    # a guild that keeps existing" and just needs the guild ID.
    member_guild_ids = await _collect_member_guild_ids(session, user_id)

    # 1. Owned guilds → cascade-delete (must happen before membership
    # cleanup so the cascade can find this user's GuildMember row too).
    owned_guild_ids = await _collect_owned_guild_ids(session, user_id)
    for gid in owned_guild_ids:
        voice_channel_ids = await _hard_delete_guild_with_attachments(session, gid)
        result.owned_voice_channel_ids.extend(voice_channel_ids)
    result.deleted_guild_ids = owned_guild_ids
    owned_set = set(owned_guild_ids)
    result.other_member_guild_ids = [
        gid for gid in member_guild_ids if gid not in owned_set
    ]

    # 2. Memberships in non-owned guilds — composite-FK on member_roles
    # cascades the role assignments.
    await session.execute(
        sa_delete(GuildMember).where(GuildMember.user_id == user_id)
    )
    # 2b. Belt-and-suspenders: explicit member_roles delete in case the
    # FK cascade has been stripped by a future schema change.
    await session.execute(
        sa_delete(MemberRole).where(MemberRole.user_id == user_id)
    )

    # 2c. Standplatz-Geraete des Nutzers. Ein Gerät in einer eigenen (schon
    # per Kaskade verschwundenen) Community ist hier bereits weg — die
    # Auswahl greift nur noch auf Geräte in fremden Communities. Aussenform
    # + Standplatz VOR dem Löschen einsammeln (die Meldung nach dem Commit
    # braucht beides, und die Zeile gibt es dann nicht mehr).
    device_rows = (
        await session.execute(
            select(Device).where(Device.owner_user_id == user_id)
        )
    ).scalars().all()
    if device_rows:
        result.removed_devices = [
            (device.id, device.guild_id, device.channel_id, device_out(device, manager).model_dump())
            for device in device_rows
        ]
        # Erst die laufende Fernsteuerung beenden, dann die Zeile löschen —
        # dieselbe Reihenfolge wie in ``remote_guard`` und
        # ``ws_device_handlers``. Ohne diesen Schritt verschwinden Zeile und
        # Registereintrag, waehrend die Sitzung weiterlaeuft: der Steuernde
        # behielte ein Geraet, das es nicht mehr gibt, und dessen Besitzer es
        # nicht mehr gibt.
        if manager is not None:
            for device in device_rows:
                await manager.end_remote_sessions_for_device(device.id)
        await session.execute(
            sa_delete(Device).where(Device.owner_user_id == user_id)
        )

    # 3. User-scoped channel overwrites.
    await session.execute(
        sa_delete(PermissionOverwrite).where(
            PermissionOverwrite.target_type == _OVERWRITE_TARGET_USER,
            PermissionOverwrite.target_id == user_id,
        )
    )

    # 4. User-authored messages (cascades reactions/mentions/attachments).
    await _delete_user_authored_messages(session, user_id)

    # 5. User's reactions on other users' messages.
    await session.execute(
        sa_delete(MessageReaction).where(MessageReaction.user_id == user_id)
    )

    # 6. Mentions that *targeted* the user. The ``<@uid>`` marker in the
    # raw message content stays — the frontend renders deleted users as
    # "@unknown" anyway (userCache miss).
    await session.execute(
        sa_delete(MessageMention).where(
            MessageMention.target_id == user_id,
            MessageMention.mention_type == MENTION_TYPE_USER,
        )
    )

    # 7. Ban records AGAINST the user — by self-delete the user no longer
    # exists so a historical ban against them is moot. Bans the user ISSUED
    # against someone else stay: a moderation decision against a still-
    # active third party must not silently lapse just because the
    # moderator later deleted their own account (Bughunt 2026-08-17). The
    # ``banned_by_id`` column has no FK to the (separate-service) users
    # table, so leaving it pointing at a deleted account is the same
    # tolerance every other unconstrained ``*_id`` column here already has
    # (mentions, invites, …) — the row itself, and the ban, keep working.
    await session.execute(
        sa_delete(GuildBan).where(GuildBan.user_id == user_id)
    )

    # 8. Web-Push subs.
    await session.execute(
        sa_delete(WebPushSubscription).where(WebPushSubscription.user_id == user_id)
    )

    # 9. DM channels the user was a participant in (1:1 → drop the
    # whole channel + every message in it).
    dm_ids = await _collect_dm_channel_ids(session, user_id)
    await _delete_dm_channels(session, dm_ids)

    # 9b. Private-Gruppen-Mitgliedschaften (Etappe G1) — s. Docstring von
    # ``user_purge_gruppen.purge_private_group_memberships`` fuer die
    # Erb-/Loesch-Regel.
    await purge_private_group_memberships(session, user_id)

    # 9c. E2E-Postfach (Etappe D) — Geraete-Buendel, Einmalschluessel und
    # Postfach-Zeilen des geloeschten Kontos, s. Modul-Docstring von
    # ``user_purge_postfach.py``. Dieselbe Faehrte wie bei
    # ``community_invite_notifications`` nach Migration 0063 (s. 9b) —
    # nicht wiederholen.
    await purge_postfach(session, user_id)

    # 9c-2. Community-Dateiablage (Etappe E8) — eigene, noch nicht gefestigte
    # Zwischenlager-Uploads. S. Modul-Docstring von ``user_purge_ablage.py``.
    await purge_ablage_zwischenlager(session, user_id)
    await purge_ablage_konto_laufwerk(session, user_id)

    # 9d. Geraete-Kopplung + Verlaufsumzug (Etappe F) — Bughunt 2026-08-29
    # (Runde 6, Befund 5): s. Modul-Docstring von ``user_purge_kopplung.py``.
    await purge_kopplung(session, user_id)

    # 10. Friendship system (Etappe 1): friendships, pending friend-
    # requests, blocks both directions, privacy row. Same pattern as
    # the DM cleanup — drop every row that mentions the user.
    await session.execute(
        sa_delete(Friendship).where(
            or_(
                Friendship.user_a_id == user_id,
                Friendship.user_b_id == user_id,
            )
        )
    )
    await session.execute(
        sa_delete(FriendRequest).where(
            or_(
                FriendRequest.sender_id == user_id,
                FriendRequest.receiver_id == user_id,
            )
        )
    )
    await session.execute(
        sa_delete(UserBlock).where(
            or_(
                UserBlock.blocker_id == user_id,
                UserBlock.blocked_id == user_id,
            )
        )
    )
    await session.execute(
        sa_delete(UserPrivacy).where(UserPrivacy.user_id == user_id)
    )

    # 10b. Community-invite broker rows (Stufe 2 / B-lite, cloud-only): drop
    # every pending invite the user sent or received. Cheap belt-and-suspenders
    # — the rows are short-lived and deleted on accept anyway, but a purge must
    # not leave dangling cards pointing at a dead account.
    await session.execute(
        sa_delete(CommunityInvite).where(
            or_(
                CommunityInvite.inviter_id == user_id,
                CommunityInvite.invitee_id == user_id,
            )
        )
    )

    # 11. User-preferences (Schritt 3b plugin/server-side-sync rows).
    await session.execute(
        sa_delete(UserPreference).where(UserPreference.user_id == user_id)
    )

    return result


async def _cleanup_redis(redis: Any, user_id: int) -> None:
    """Best-effort: clear voice-presence + HQ-stream-active keys for
    the purged user. Failures are logged + swallowed — the LiveKit
    webhook + media-svc poller self-heal these on their next tick."""
    if redis is None:
        return
    uid_str = str(user_id)
    # voice:room:channel-*  (member set) + :streaming (per-channel
    # browser-screenshare flag). We SCAN-iterate to avoid loading
    # every voice room key at once on a big deployment.
    try:
        async for key in redis.scan_iter(match="voice:room:channel-*", count=200):
            try:
                # SCAN can yield bytes; SREM tolerates both.
                await redis.srem(key, uid_str)
            except Exception:  # noqa: BLE001
                log.warning("purge: srem failed for %s", key, exc_info=True)
    except Exception:  # noqa: BLE001
        log.warning("purge: voice-room scan failed", exc_info=True)

    # stream:active:channel-<cid>-<uid> — per-user HQ-stream marker.
    try:
        pattern = f"stream:active:channel-*-{uid_str}"
        async for key in redis.scan_iter(match=pattern, count=200):
            try:
                await redis.delete(key)
            except Exception:  # noqa: BLE001
                log.warning("purge: del failed for %s", key, exc_info=True)
    except Exception:  # noqa: BLE001
        log.warning("purge: stream-active scan failed", exc_info=True)


async def purge_user(
    session: AsyncSession,
    user_id: int,
    *,
    manager: ConnectionManager | None = None,
    redis: Any = None,
) -> dict[str, Any]:
    """Run the full purge for ``user_id`` and broadcast lifecycle
    events. Idempotent — second call is a no-op (all DELETEs are
    where-clauses).

    Returns ``{"deleted_guild_ids": [...]}`` so the caller can log /
    assert in tests.
    """
    try:
        result = await _purge_db(session, user_id, manager)
        await session.commit()
    except Exception:
        await session.rollback()
        raise
    deleted_guild_ids = result.deleted_guild_ids
    # Broadcast guild_deleted *after* commit so subscribers can't see
    # an inconsistent half-state if they round-trip back to the API.
    if manager is not None:
        from dcc_shared.events import GuildDeletedEvent

        for gid in deleted_guild_ids:
            try:
                await manager.publish_guild_event(
                    GuildDeletedEvent(guild_id=str(gid))
                )
            except Exception:  # noqa: BLE001
                log.warning("purge: guild_deleted publish failed", exc_info=True)
    # MinIO objects of every hard-deleted owned guild's dropbox — same
    # after-commit pattern as ``routes/guilds.py::delete_guild``: ON DELETE
    # CASCADE already cleared the DB rows, MinIO never learns of that on
    # its own.
    for gid in deleted_guild_ids:
        try:
            await purge_guild_dropbox_objects(gid)
        except Exception:  # noqa: BLE001
            log.warning("purge: dropbox object purge failed for guild %s", gid, exc_info=True)
    await evict_voice_sessions(
        session,
        redis,
        user_id,
        owned_voice_channel_ids=result.owned_voice_channel_ids,
        other_member_guild_ids=result.other_member_guild_ids,
    )
    await forget_devices(manager, result.removed_devices)
    await _cleanup_redis(redis, user_id)
    return {"deleted_guild_ids": [str(g) for g in deleted_guild_ids]}
