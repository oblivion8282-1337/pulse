"""Einladungs-Benachrichtigungen an Nicht-Freunde (Cloud-only, v1).

POST /guilds/{guild_id}/member-invites      Einladung per Nutzername (CREATE_INVITES)
GET  /me/community-invites                  pending Einladungen des Empfängers
POST /me/community-invites/{id}/accept      Membership anlegen (Join-Pfad des Invite-Codes)
POST /me/community-invites/{id}/decline     ablehnen (Historie bleibt)

Fährt auf den Schienen der Freundschaftsanfragen (User-Entscheidung
2026-07-13: DMs bleiben strikt friends-only): Zustellung als
``community_invite_received``-Event + ready-Frame-Hydration, Annehmen/
Ablehnen-Karten beim Empfänger. NUR Cloud-Communities — eine Nutzername-
Einladung auf einen Self-Host wäre cross-server (Empfänger müsste erst
Instanz-Mitglied werden) und ist bewusst nicht Teil von v1; dort deckt
„Oder Link teilen" den Fall. Abgrenzung zum ``community_invites``-Broker
(Friend-zu-Friend, DM-Karte, auch Self-Host-Ziele): eigener Weg, eigene
Tabelle.

Nutzername-Auflösung: ``cached_user_profiles`` (exakter, case-insensitiver
Match) — die chat-native Quelle, aus der auch die Mention-Suche liest. Auf
der Cloud hat jeder aktive User eine Profil-Statement-Zeile; wer keine hat,
ist für die Chat-Ebene ohnehin (noch) nicht adressierbar → 404.
"""

from __future__ import annotations

from dcc_shared.permissions import Permissions
from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.friend_events import publish_friend_event
from dcc_chat_gateway.friend_helpers import block_exists_either_way
from dcc_chat_gateway.invite_host import fremder_host
from dcc_chat_gateway.models import (
    CommunityInviteNotification,
    Guild,
    GuildMember,
)
from dcc_chat_gateway.models.moderation import CachedUserProfile
from dcc_chat_gateway.permissions import check_permission
from dcc_chat_gateway.ratelimit import check as ratelimit_check
from dcc_chat_gateway.routes._deps import CloudOnly
from dcc_chat_gateway.routes.invites import _join_guild
from dcc_chat_gateway.schemas import InviteAcceptOut, InviteGuildOut
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

router = APIRouter(dependencies=[CloudOnly])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class CreateMemberInviteIn(BaseModel):
    username: str = Field(min_length=1, max_length=50)


class CommunityInviteNotificationOut(BaseModel):
    id: str  # Snowflake-String-API
    guild_id: str
    # Denormalisiert für die Empfänger-Karte: der Eingeladene ist (noch) kein
    # Member und kann den Guild-Namen nirgendwo sonst nachschlagen.
    guild_name: str
    inviter_user_id: str
    invitee_user_id: str
    # NULL = Cloud-Ziel. Die Karte zeigt ihn an, damit der Eingeladene sieht,
    # auf welchen Server er tritt.
    target_host: str | None
    # Host-coined Code — seit 2026-08-30 in der Liste: der Klient joint
    # Link-artig VOR dem Annehmen (die Karte bleibt bei Fehlschlag erhalten)
    # und lässt das Annehmen nur noch als Buchhaltung laufen. Der Empfänger
    # könnte den Code über das Annehmen ohnehin lesen; der Host prüft ihn
    # beim Beitritt live.
    code: str | None
    created_at: str


def _to_out(row: CommunityInviteNotification, guild_name: str) -> CommunityInviteNotificationOut:
    return CommunityInviteNotificationOut(
        id=str(row.id),
        guild_id=str(row.guild_id),
        guild_name=guild_name,
        inviter_user_id=str(row.inviter_user_id),
        invitee_user_id=str(row.invitee_user_id),
        # Durch `fremder_host`: die Spalte MEINT „NULL = Cloud", geschrieben
        # wurde aber lange die eigene Adresse. Hier gefiltert heilen die
        # bestehenden Zeilen von selbst — die Karte zeigte sonst
        # „https://howispulse.com" unter jeder Cloud-Einladung.
        target_host=fremder_host(row.target_host),
        code=row.code,
        created_at=row.created_at.isoformat(),
    )


async def load_pending_invites_with_guild(
    session, invitee_user_id: int
) -> list[CommunityInviteNotificationOut]:
    """Offene Einladungen des Empfängers — geteilt zwischen
    ``GET /me/community-invites`` und der ready-Frame-Hydration.

    **LEFT JOIN, nicht INNER:** ein Self-Host-Ziel hat in der Cloud keine
    ``guilds``-Zeile, ein INNER JOIN würde genau diese Einladungen
    verschlucken. Der Name kommt bevorzugt aus der denormalisierten Spalte
    und nur ersatzweise aus der Guild-Tabelle (Zeilen von vor Migration 0063
    haben die Spalte noch nicht gefüllt)."""
    rows = (
        await session.execute(
            select(CommunityInviteNotification, Guild.name)
            .outerjoin(Guild, Guild.id == CommunityInviteNotification.guild_id)
            .where(CommunityInviteNotification.invitee_user_id == invitee_user_id)
            .order_by(CommunityInviteNotification.created_at.desc())
        )
    ).all()
    return [_to_out(row, row.guild_name or name or "") for row, name in rows]


async def _resolve_username(session, username: str) -> int:
    """Exakter, case-insensitiver Nutzername → Cloud-User-ID (s. Modul-Doku)."""
    row = (
        await session.execute(
            select(CachedUserProfile.user_identifier).where(
                func.lower(CachedUserProfile.username) == username.strip().lower()
            )
        )
    ).scalars().first()
    if row is None or not row.isdigit():
        # isdigit-Guard: auf Self-Host wären identifier pairwise-subs — dieser
        # Router ist zwar CloudOnly, aber defensiv bleiben.
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="user_not_found")
    return int(row)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post(
    "/guilds/{guild_id}/member-invites",
    response_model=CommunityInviteNotificationOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_member_invite(
    guild_id: int,
    payload: CreateMemberInviteIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Cloud-User per Nutzername in die Community einladen."""
    if not ratelimit_check("member_invite", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limit exceeded")

    await check_permission(session, current, guild_id, Permissions.CREATE_INVITES)
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="guild_not_found")

    invitee_id = await _resolve_username(session, payload.username)
    if invitee_id == current.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="cannot_invite_yourself")

    # Block-Gate zuerst (gewinnt immer, kein Existence-Leak über die Details).
    if await block_exists_either_way(session, current.id, invitee_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="block_in_place")

    if await session.get(GuildMember, (guild_id, invitee_id)) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="already_member")

    # Dedupe-Guard: EIN offener Antrag pro (guild, invitee) — egal von wem
    # (kein Spam-Stapel durch mehrere Absender). Guard-Query statt partiellem
    # Unique-Index (SQLite-Tests); das Race-Fenster ist akzeptiert, wie bei
    # der Friend-Request-Forward-Prüfung.
    dup = (
        await session.execute(
            select(CommunityInviteNotification.id).where(
                CommunityInviteNotification.guild_id == guild_id,
                CommunityInviteNotification.invitee_user_id == invitee_id,
            )
        )
    ).first()
    if dup is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="invite_already_pending")

    row = CommunityInviteNotification(
        id=next_id(),
        guild_id=guild_id,
        inviter_user_id=current.id,
        invitee_user_id=invitee_id,
        guild_name=guild.name,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)

    out = _to_out(row, guild.name)
    # Direct-Delivery an den Empfänger — gleiche Schiene wie
    # ``friend_request_received`` (user:events). Re-Sync über den ready-Frame
    # (``community_invites``-Feld) deckt Offline-Empfänger ab.
    await publish_friend_event(
        request,
        target_user_id=invitee_id,
        op="community_invite_received",
        data=out.model_dump(mode="json"),
    )
    return out


@router.get(
    "/me/community-invites",
    response_model=list[CommunityInviteNotificationOut],
)
async def list_my_community_invites(session: SessionDep, current: CurrentUser):
    """Pending Einladungen des eingeloggten Users (mit Guild-Name)."""
    return await load_pending_invites_with_guild(session, current.id)


async def _load_pending_for_invitee(
    session, invite_id: int, user_id: int
) -> CommunityInviteNotification:
    """Zeile laden; 404 wenn fremd oder nicht mehr da (kein Existence-Leak an
    Dritte — wie ``load_request_for_caller`` im Friend-System). Eine
    entschiedene Einladung ist gelöscht, „schon entschieden" und „gab es nie"
    sind hier also derselbe Fall."""
    row = await session.get(CommunityInviteNotification, invite_id, with_for_update=True)
    if row is None or row.invitee_user_id != user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="invite_not_found")
    return row


@router.post("/me/community-invites/{invite_id}/accept", response_model=InviteAcceptOut)
async def accept_community_invite(
    invite_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Einladung annehmen.

    Zwei Fälle. **Cloud-Ziel:** Mitgliedschaft anlegen, mit identischen
    Seiteneffekten wie der Invite-Code-Beitritt (Ban-Gate, GuildMember-Insert,
    ``guild_member_added``-Broadcast, Ziel-Channel für die Navigation).
    **Fremder Host:** die Cloud gibt ``{target_host, code}`` zurück und der
    Klient geht seinen normalen Beitrittsweg gegen den Host, der den Code live
    prüft. In beiden Fällen ist die Zeile danach weg — entschieden ist
    entschieden, ein Verlaufsregister führen wir nicht.
    """
    row = await _load_pending_for_invitee(session, invite_id, current.id)

    if row.target_host:
        # Kein Ban-Gate, kein Member-Cap: beides gehört dem Host, und die Cloud
        # kann es nicht kennen. Der Host lehnt beim Einlösen ab, wenn nötig.
        ausgabe = InviteAcceptOut(
            guild=InviteGuildOut(id=row.guild_id, name=row.guild_name or "", icon_url=None),
            channel_id=None,
            target_host=row.target_host,
            code=row.code,
        )
        await session.delete(row)
        await session.commit()
        return ausgabe

    guild = await session.get(Guild, row.guild_id)
    if guild is None:
        # Community wurde gelöscht, während die Einladung offen war. Seit
        # Migration 0063 gibt es keinen FK-CASCADE mehr, der das nebenbei
        # erledigt — hier wird tatsächlich aufgeräumt, nicht nur defensiv.
        await session.delete(row)
        await session.commit()
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="invite_not_found")

    # Die Zeile verschwindet im selben Commit wie die Mitgliedschaft (der
    # Helfer committet); rollt er zurück — Ban-Rennen, Race um die Mitglieds-
    # schaft —, bleibt die Einladung offen. Ban-Vorprüfung, Member-Cap,
    # Insert und Broadcast macht der gemeinsame Kern (``_join_guild``).
    # Guild-Felder VOR dem Helfer snapshoten: ein IntegrityError-Rollback
    # darin expiret die ORM-Attribute, und die Antwort baut sonst auf einem
    # weggeputzten Objekt neu auf (MissingGreenlet → 500 statt idempotent
    # 200) — gleiche Vorkehrung wie accept_invite.
    guild_name, guild_icon = guild.name, guild.icon_url
    await session.delete(row)
    _, channel_id = await _join_guild(session, request, row.guild_id, current.id)
    return InviteAcceptOut(
        guild=InviteGuildOut(id=row.guild_id, name=guild_name, icon_url=guild_icon),
        channel_id=channel_id,
    )


@router.post(
    "/me/community-invites/{invite_id}/decline",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def decline_community_invite(
    invite_id: int,
    session: SessionDep,
    current: CurrentUser,
):
    """Einladung ablehnen — die Zeile wird gelöscht. Bewusst KEIN Event an den
    Einlader (anders als der Friend-Request-Decline, wo der Sender seine
    Outgoing-Liste pflegt): der Einlader hat keine Pending-Liste im UI, und
    stilles Ablehnen vermeidet sozialen Druck.

    Folge des Löschens: derselbe Einladende kann sofort erneut einladen. Das
    ist der bewusst gezahlte Preis dafür, keine Ablehnungs-Historie über
    Personen zu führen; gegen Stapel schützt der Rate-Limiter."""
    row = await _load_pending_for_invitee(session, invite_id, current.id)
    await session.delete(row)
    await session.commit()
