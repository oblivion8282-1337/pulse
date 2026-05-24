"""User-preferences routes — Plugin-System Schritt 3b.

Server-side mirror of ``$lib/settings-registry`` sections that opt
into cross-device sync via ``persistence: 'server' | 'both'`` on the
frontend ``SectionConfig``. The Pulse default stays
``localStorage``-only — these routes only see traffic from sections
that explicitly opt in.

Endpoints
---------

* ``GET    /preferences``           — all sections of the caller as
                                       ``{section_name: {value, version}}``.
* ``GET    /preferences/{section}`` — one section as
                                       ``{value, version, updated_at}``.
                                       404 when no row exists; the client
                                       is expected to fall back to its
                                       own defaults.
* ``PUT    /preferences/{section}`` — upsert. Body ``{value: any}``;
                                       optional ``If-Match: <version>``
                                       header for optimistic concurrency
                                       (412 on mismatch).
* ``DELETE /preferences/{section}`` — drop the row. 204 even when there
                                       was no row to drop — idempotent.

The ``section_name`` path param is constrained to the same charset as
the plugin name (``^[a-z][a-z0-9_:-]{0,63}$``, plus colon for
namespaced sections like ``"tamagotchi:state"``). The route returns
400 on violations rather than silently inserting whatever string the
caller sent — that way malformed reads/writes fail loud.
"""

from __future__ import annotations

import re
from typing import Annotated, Any

from fastapi import APIRouter, Header, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import UserPreference
from dcc_chat_gateway.security import CurrentUser

router = APIRouter()

# Match the plugin-name charset (manifest.py ``^[a-z][a-z0-9_-]{1,31}$``)
# but allow colons for nested sections (``"tamagotchi:state"``) and a
# wider length cap (64 — same as the DB column). Reject everything else
# at the route boundary so a malformed write never silently inserts a
# garbage row.
_SECTION_NAME_RE = re.compile(r"^[a-z][a-z0-9_:-]{0,63}$")


class PreferenceOut(BaseModel):
    """One section's value as returned by GET/PUT."""

    value: Any
    version: int


class PreferenceFullOut(PreferenceOut):
    """Like ``PreferenceOut`` but with the ``updated_at`` timestamp.

    Single-section reads include it so the frontend can render
    "last synced" UI; the bulk GET omits it to keep the payload
    compact.
    """

    updated_at: str


class PreferenceIn(BaseModel):
    """PUT body — opaque JSON ``value``.

    ``version`` in the body is *advisory* — the route layer never
    trusts it for concurrency (use the ``If-Match`` header for that).
    The field exists so frontends can echo back what they think the
    current version is for debugging.
    """

    value: Any
    version: int | None = Field(default=None)


def _validate_section(name: str) -> str:
    if not _SECTION_NAME_RE.match(name):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="invalid_section_name"
        )
    return name


def _parse_if_match(if_match: str | None) -> int | None:
    """Parse the ``If-Match`` header into a version integer.

    Accepts plain ints (``"3"``) and quoted ETags (``'"3"'``); the
    HTTP spec is the latter, but our client is colocated and the bare
    form is simpler. Empty / missing → ``None`` (no concurrency check).
    """
    if not if_match:
        return None
    raw = if_match.strip().strip('"')
    try:
        return int(raw)
    except ValueError:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="invalid_if_match"
        )


@router.get("/preferences", response_model=dict[str, PreferenceOut])
async def list_my_preferences(session: SessionDep, current: CurrentUser):
    """All sections for the caller, keyed by ``section_name``.

    Returns ``{}`` when the user has never written any preference —
    cheap fast path for fresh accounts. The frontend treats absence
    as "use defaults".
    """
    stmt = select(UserPreference).where(UserPreference.user_id == current.id)
    rows = (await session.execute(stmt)).scalars().all()
    return {
        row.section_name: PreferenceOut(value=row.value, version=row.version)
        for row in rows
    }


@router.get(
    "/preferences/{section}",
    response_model=PreferenceFullOut,
)
async def get_my_preference(
    section: str,
    session: SessionDep,
    current: CurrentUser,
):
    _validate_section(section)
    row = await session.get(UserPreference, (current.id, section))
    if row is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="section_not_found"
        )
    return PreferenceFullOut(
        value=row.value,
        version=row.version,
        updated_at=row.updated_at.isoformat() if row.updated_at else "",
    )


@router.put("/preferences/{section}", response_model=PreferenceOut)
async def put_my_preference(
    section: str,
    payload: PreferenceIn,
    session: SessionDep,
    current: CurrentUser,
    if_match: Annotated[str | None, Header(alias="If-Match")] = None,
):
    """Upsert one section.

    Behaviour:
      - No row exists → insert with ``version=1``. ``If-Match`` is
        ignored on insert (no prior version to match against; the
        client effectively says "I'm OK if this is a fresh insert").
      - Row exists → bump ``version`` by 1. If ``If-Match`` was
        provided and doesn't equal the *current* (pre-bump) version,
        return 412.
    """
    _validate_section(section)
    expected = _parse_if_match(if_match)

    row = await session.get(UserPreference, (current.id, section))
    if row is None:
        row = UserPreference(
            user_id=current.id,
            section_name=section,
            value=payload.value,
            version=1,
        )
        session.add(row)
    else:
        if expected is not None and expected != row.version:
            raise HTTPException(
                status.HTTP_412_PRECONDITION_FAILED,
                detail="version_mismatch",
            )
        row.value = payload.value
        row.version = row.version + 1
    await session.commit()
    await session.refresh(row)
    return PreferenceOut(value=row.value, version=row.version)


@router.delete(
    "/preferences/{section}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_my_preference(
    section: str,
    session: SessionDep,
    current: CurrentUser,
):
    """Drop one section. Idempotent — 204 even when no row existed.

    Frontend semantics: "fall back to defaults from now on". The local
    settings-registry section is *not* reset by this call — the client
    decides whether to call ``store.reset()`` separately.
    """
    _validate_section(section)
    await session.execute(
        delete(UserPreference).where(
            UserPreference.user_id == current.id,
            UserPreference.section_name == section,
        )
    )
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


__all__ = ["router"]
