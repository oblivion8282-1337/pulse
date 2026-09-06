"""Die Community stellt ihre eigenen Grenzen ein — innerhalb der des Betreibers.

Gegenstück zu ``/owner/communities/{id}/limits``: dieselben Limits, aber
MANAGE_GUILD statt Betreiber, und jeder Wert wird auf die Obergrenze geklemmt
(``guild_limits.clamp_to_ceilings``).

Geklemmt wird sichtbar, nicht per Fehler: die Antwort trägt die tatsächlich
gespeicherten Werte plus ``clamped`` mit den Schlüsseln, die zurückgeholt
wurden. Die Oberfläche zeigt danach die Wahrheit und sagt dazu, was angepasst
wurde — ein 409 würde das Formular nur abweisen, ohne dass jemand erfährt, wo
die Grenze liegt.

``GET`` liefert zu jedem Limit auch die Obergrenze, damit das Formular den
Rahmen anzeigen kann, in dem sich die Community bewegen darf.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Request

from dcc_chat_gateway import guild_limits as limits
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import Guild

from dcc_chat_gateway.routes._deps import guild_or_404, publish_guild_event
from dcc_chat_gateway.permissions import Permissions, check_permission
from dcc_chat_gateway.schemas import GuildLimitsOut, GuildLimitsPatch, GuildLimitValue
from dcc_chat_gateway.security import CurrentUser
from dcc_shared.events import GuildUpdatedEvent

router = APIRouter(tags=["guild-limits"])


def _limits_out(guild: Guild, clamped: list[str] | None = None) -> GuildLimitsOut:
    return GuildLimitsOut(
        limits={
            spec.key: GuildLimitValue(
                value=getattr(guild, spec.value_attr),
                ceiling=limits.ceiling_of(guild, spec),
                effective=limits.effective(guild, spec),
            )
            for spec in limits.LIMITS
        },
        clamped=clamped or [],
    )


@router.get("/guilds/{guild_id}/limits", response_model=GuildLimitsOut)
async def get_guild_limits(
    guild_id: Annotated[int, Path(ge=1)],
    session: SessionDep,
    current: CurrentUser,
) -> GuildLimitsOut:
    guild = await guild_or_404(session, guild_id)
    await check_permission(session, current, guild_id, Permissions.MANAGE_GUILD)
    return _limits_out(guild)


@router.patch("/guilds/{guild_id}/limits", response_model=GuildLimitsOut)
async def patch_guild_limits(
    guild_id: Annotated[int, Path(ge=1)],
    payload: GuildLimitsPatch,
    request: Request,
    session: SessionDep,
    current: CurrentUser,
) -> GuildLimitsOut:
    """Setzt die Werte der Community. Nicht genannte Limits bleiben unberührt,
    ein ausdrückliches ``null`` löscht den eigenen Wert (dann gilt wieder die
    Obergrenze)."""
    guild = await guild_or_404(session, guild_id)
    await check_permission(session, current, guild_id, Permissions.MANAGE_GUILD)

    unknown = set(payload.limits) - set(limits.LIMITS_BY_KEY)
    if unknown:
        raise HTTPException(422, detail=f"unknown limits: {sorted(unknown)}")

    try:
        cleaned = {
            key: limits.coerce_value(limits.LIMITS_BY_KEY[key], value)
            for key, value in payload.limits.items()
        }
    except ValueError as exc:
        raise HTTPException(422, detail=str(exc)) from exc

    for key, value in cleaned.items():
        setattr(guild, limits.LIMITS_BY_KEY[key].value_attr, value)

    clamped = limits.clamp_to_ceilings(guild)
    await session.commit()
    await session.refresh(guild)

    # Mitglieder müssen die neuen Grenzen sofort sehen — der Publish-Pfad
    # klemmt clientseitig gegen genau diese Werte.
    from dcc_chat_gateway.routes.guilds import _guild_dict

    await publish_guild_event(request, GuildUpdatedEvent(guild=_guild_dict(guild)))

    return _limits_out(guild, clamped)
