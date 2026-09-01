"""Ob zwei Konten einen Ablage-Kanal gemeinsam SEHEN duerfen.

Erweitert ``schluessel_zugriff.py`` um den Fall, den der Ablage-Kanal
braucht: eine gemeinsame Community allein berechtigt NICHT (das waere ein
Datenschutz-Rueckschritt — jedes Mitglied koennte dann die Geraeteschluessel
jedes anderen Mitglieds einer grossen Community abholen), aber ein Kanal, den
beide via ``VIEW_CHANNEL`` sehen duerfen, sehr wohl: die Megolm-Sitzung fuer
den Kanal reist ueber je eine 1:1-Olm-Sitzung zu jedem Geraet jedes
Sicht-Berechtigten, und dafuer braucht der Absender deren Buendel — genau wie
bei ``private_gruppen_zugriff.py::teilen_private_gruppe``, nur dass der
Bezugspunkt hier der KANAL ist, nicht die Community.
"""

from __future__ import annotations

from sqlalchemy import select

from dcc_chat_gateway._members_view import _Ctx
from dcc_chat_gateway.models import (
    Channel,
    Guild,
    GuildMember,
    MemberRole,
    PermissionOverwrite,
    Role,
)
from dcc_shared.permission_resolver import (
    Override,
    RoleSnapshot,
    calculate_channel_permissions,
    has_permission,
)
from dcc_shared.permissions import Permissions


async def teilen_ablage_kanal(session, a_id: int, b_id: int) -> bool:
    """Ob ``a_id`` und ``b_id`` mindestens einen Ablage-Kanal gemeinsam sehen.

    Kandidaten: Ablage-Kanaele (``Channel.ablage``) in Communities, in denen
    BEIDE Mitglied sind (zwei ``JOIN``s auf ``guild_members`` statt eines
    Self-Joins wie bei ``teilen_private_gruppe`` — hier braucht es zusaetzlich
    die Guild-ID fuer die anschliessende Rechteauswertung). Fuer jeden
    Kandidaten wird ``VIEW_CHANNEL`` fuer BEIDE Konten ueber denselben
    Resolver berechnet, den auch ``permissions.py::resolve_permissions``
    verwendet (``dcc_shared.permission_resolver``) — kein eigener,
    zweiter Rechte-Weg.

    Kosten: eine feste Anzahl Abfragen, unabhaengig von der Kanalzahl der
    Communities — nicht eine je Kandidat. Die erste Abfrage liefert die
    Kandidaten (typischerweise 0 oder 1, da Ablage-Kanaele heute
    Singletons pro Community sind); danach je EINE Abfrage fuer alle
    betroffenen Rollen, alle Rollenzuweisungen der zwei Konten in diesen
    Communities und alle Kanal-Overwrites der Kandidaten-Kanaele — macht
    vier Abfragen total, auch wenn beide Konten in vielen Communities
    gemeinsam sind. Erst wenn ein Kandidat fuer beide ``VIEW_CHANNEL``
    ergibt, kehrt die Funktion zurueck (kein weiteres Durchrechnen).

    Der globale Admin-Status ist hier nicht bekannt (nur Konto-IDs, keine
    ``AuthenticatedUser``-Nutzlast) und geht deshalb konservativ als
    ``False`` ein — wie in ``_members_view.py`` an vergleichbarer Stelle.
    Das unterschaetzt allenfalls die Sicht eines Admins, verschafft aber nie
    zu Unrecht Zugriff (fail-closed).
    """
    if a_id == b_id:
        return False

    gm_a = GuildMember.__table__.alias("gm_ablage_a")
    gm_b = GuildMember.__table__.alias("gm_ablage_b")
    kandidaten = (
        await session.execute(
            select(Channel.id, Channel.guild_id, Guild.owner_id)
            .select_from(Channel)
            .join(Guild, Guild.id == Channel.guild_id)
            .join(gm_a, (gm_a.c.guild_id == Channel.guild_id) & (gm_a.c.user_id == a_id))
            .join(gm_b, (gm_b.c.guild_id == Channel.guild_id) & (gm_b.c.user_id == b_id))
            .where(Channel.ablage.is_(True))
        )
    ).all()
    if not kandidaten:
        return False

    guild_ids = {gid for (_cid, gid, _owner) in kandidaten}
    channel_ids = [cid for (cid, _gid, _owner) in kandidaten]

    rollen_je_guild: dict[int, dict[int, Role]] = {}
    everyone_je_guild: dict[int, Role] = {}
    for r in (
        await session.execute(select(Role).where(Role.guild_id.in_(guild_ids)))
    ).scalars():
        rollen_je_guild.setdefault(r.guild_id, {})[r.id] = r
        if r.is_everyone:
            everyone_je_guild[r.guild_id] = r

    zuweisung: dict[tuple[int, int], list[int]] = {}
    for gid, uid, rid in (
        await session.execute(
            select(MemberRole.guild_id, MemberRole.user_id, MemberRole.role_id).where(
                MemberRole.guild_id.in_(guild_ids),
                MemberRole.user_id.in_((a_id, b_id)),
            )
        )
    ).all():
        zuweisung.setdefault((gid, uid), []).append(rid)

    overwrites_je_kanal: dict[int, dict[tuple[int, int], Override]] = {}
    for ow in (
        await session.execute(
            select(PermissionOverwrite).where(
                PermissionOverwrite.channel_id.in_(channel_ids)
            )
        )
    ).scalars():
        overwrites_je_kanal.setdefault(ow.channel_id, {})[
            (ow.target_type, ow.target_id)
        ] = Override(allow=ow.allow_bf, deny=ow.deny_bf)

    def _rollen_snapshot(guild_id: int, user_id: int) -> list[RoleSnapshot]:
        role_by_id = rollen_je_guild.get(guild_id, {})
        role_ids = set(zuweisung.get((guild_id, user_id), ()))
        everyone = everyone_je_guild.get(guild_id)
        if everyone is not None:
            role_ids.add(everyone.id)
        return [
            RoleSnapshot(
                id=role.id,
                position=role.position,
                permissions=role.permissions,
                is_everyone=role.is_everyone,
            )
            for rid in role_ids
            if (role := role_by_id.get(rid)) is not None
        ]

    for channel_id, guild_id, owner_id in kandidaten:
        overwrites = overwrites_je_kanal.get(channel_id, {})
        beide_sehen = True
        for user_id in (a_id, b_id):
            ctx = _Ctx(
                user=user_id,
                admin=False,
                owner=owner_id == user_id,
                member=True,
                roles=_rollen_snapshot(guild_id, user_id),
                overwrites=overwrites,
            )
            if not has_permission(
                calculate_channel_permissions(ctx), Permissions.VIEW_CHANNEL
            ):
                beide_sehen = False
                break
        if beide_sehen:
            return True
    return False
