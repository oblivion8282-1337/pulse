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

Backup-Onboarding-Preference (Cross-Device-Sync)
-------------------------------------------------

* ``GET  /me/preferences/backup-onboarding`` — Gibt zurück ob der User
  schon entschieden hat (``decided`` / ``decision`` / ``decided_at``).
  Neuer User → ``{decided: false, decision: null, decided_at: null}``.
* ``PATCH /me/preferences/backup-onboarding`` — Persistiert die
  Entscheidung (``"skipped"`` / ``"configured"``). Zweiter Aufruf mit
  anderer decision → 409 (idempotent; nur einmal entscheiden).
  Intern: ``user_preferences`` section ``"backup_onboarding"``.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Header, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

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
        try:
            await session.commit()
        except IntegrityError:
            # Concurrent first-insert installed the row first; fall back to
            # the update path against the now-existing row (mirrors the
            # friends.py race handling).
            await session.rollback()
            row = await session.get(UserPreference, (current.id, section))
            if row is None:
                raise HTTPException(500, detail="preference_race_lost")
            _apply_update(row, payload, expected)
            await session.commit()
    else:
        _apply_update(row, payload, expected)
        await session.commit()
    await session.refresh(row)
    return PreferenceOut(value=row.value, version=row.version)


def _apply_update(
    row: UserPreference, payload: PreferenceIn, expected: int | None
) -> None:
    """Bump an existing preference row, enforcing the optional If-Match."""
    if expected is not None and expected != row.version:
        raise HTTPException(
            status.HTTP_412_PRECONDITION_FAILED,
            detail="version_mismatch",
        )
    row.value = payload.value
    row.version = row.version + 1


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


# ---------------------------------------------------------------------------
# Backup-Onboarding-Preference (Cross-Device-Sync)
# ---------------------------------------------------------------------------

_BACKUP_ONBOARDING_SECTION = "backup_onboarding"


class BackupOnboardingOut(BaseModel):
    """Response für GET /me/preferences/backup-onboarding.

    ``decided`` ist ``false`` wenn der User noch nie entschieden hat
    (frischer Account oder alle Geräte). ``decision`` + ``decided_at``
    sind dann ``None``.
    """

    decided: bool
    decision: Literal["skipped", "configured"] | None = None
    decided_at: str | None = None


class BackupOnboardingPatch(BaseModel):
    """PATCH-Body: Entscheidung persistieren."""

    decision: Literal["skipped", "configured"]


@router.get(
    "/me/preferences/backup-onboarding",
    response_model=BackupOnboardingOut,
)
async def get_backup_onboarding_preference(
    session: SessionDep,
    current: CurrentUser,
) -> BackupOnboardingOut:
    """Gibt zurück ob der User die Backup-Onboarding-Entscheidung bereits
    getroffen hat. Neuer User / noch nicht entschieden → ``decided=false``.

    Der Client nutzt das als Cross-Device-Sync: nach dem Login wird erst
    das Backend gefragt, bevor der lokale localStorage-Fallback greift.
    """
    row = await session.get(UserPreference, (current.id, _BACKUP_ONBOARDING_SECTION))
    if row is None:
        return BackupOnboardingOut(decided=False)
    payload = row.value or {}
    decision = payload.get("decision")
    if decision not in ("skipped", "configured"):
        # Korrupter/alter Eintrag → als undecided behandeln.
        return BackupOnboardingOut(decided=False)
    return BackupOnboardingOut(
        decided=True,
        decision=decision,
        decided_at=payload.get("decided_at"),
    )


async def _resolve_backup_onboarding(
    session: SessionDep,
    row: UserPreference,
    payload: BackupOnboardingPatch,
    now_iso: str,
) -> BackupOnboardingOut:
    """Apply the once-only onboarding decision against an existing row.

    Same decision → idempotent 200 (no write). Different decision → 409.
    Missing decision on the row → fill it in.
    """
    existing_decision = (row.value or {}).get("decision")
    if existing_decision is not None and existing_decision != payload.decision:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="already_decided",
        )
    if existing_decision == payload.decision:
        # Idempotent: selbe Decision → 200 ohne DB-Write.
        return BackupOnboardingOut(
            decided=True,
            decision=payload.decision,
            decided_at=(row.value or {}).get("decided_at"),
        )
    # Row existiert, decision fehlt → update.
    row.value = {"decision": payload.decision, "decided_at": now_iso}
    row.version = row.version + 1
    await session.commit()
    await session.refresh(row)
    return BackupOnboardingOut(
        decided=True,
        decision=(row.value or {}).get("decision"),
        decided_at=(row.value or {}).get("decided_at"),
    )


@router.patch(
    "/me/preferences/backup-onboarding",
    response_model=BackupOnboardingOut,
)
async def patch_backup_onboarding_preference(
    payload: BackupOnboardingPatch,
    session: SessionDep,
    current: CurrentUser,
) -> BackupOnboardingOut:
    """Persistiert die Onboarding-Entscheidung (einmalig, idempotent).

    Zweiter Aufruf mit einer **anderen** decision → 409.
    Zweiter Aufruf mit **derselben** decision → 200 (idempotent).

    Speicherformat: ``user_preferences`` section ``"backup_onboarding"``,
    payload ``{"decision": "skipped"|"configured", "decided_at": <ISO8601>}``.
    """
    row = await session.get(UserPreference, (current.id, _BACKUP_ONBOARDING_SECTION))

    now_iso = datetime.now(tz=timezone.utc).isoformat()

    if row is None:
        row = UserPreference(
            user_id=current.id,
            section_name=_BACKUP_ONBOARDING_SECTION,
            value={"decision": payload.decision, "decided_at": now_iso},
            version=1,
        )
        session.add(row)
        try:
            await session.commit()
            await session.refresh(row)
        except IntegrityError:
            # Concurrent first-insert won the race; re-fetch and resolve via
            # the existing-row path (mirrors the friends.py race handling).
            await session.rollback()
            row = await session.get(
                UserPreference, (current.id, _BACKUP_ONBOARDING_SECTION)
            )
            if row is None:
                raise HTTPException(500, detail="preference_race_lost")
            return await _resolve_backup_onboarding(session, row, payload, now_iso)
    else:
        return await _resolve_backup_onboarding(session, row, payload, now_iso)

    return BackupOnboardingOut(
        decided=True,
        decision=(row.value or {}).get("decision"),
        decided_at=(row.value or {}).get("decided_at"),
    )


__all__ = ["router"]
