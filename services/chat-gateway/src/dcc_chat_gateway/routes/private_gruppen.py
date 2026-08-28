"""Private Gruppenkanaele (Etappe G1, die Kanal-Haelfte).

``POST /gruppen`` legt eine neue Gruppe an, ``GET /gruppen``/``GET
/gruppen/{id}`` listen sie, ``POST .../mitglieder`` und ``DELETE
.../mitglieder/{user_id}`` verwalten die Mitgliedschaft, ``POST
.../verlassen`` laesst ein Mitglied selbst gehen. Ohne Krypto, ohne
Oberflaeche — s. Umsetzungsplan
``docs/superpowers/plans/2026-08-28-etappe-g1-private-gruppen-kanal.md``.

**Cloud-only, aus demselben Grund wie Freunde/DM/Blocks**
(``routes/_deps.py::require_cloud``): eine private Gruppe prueft beim
Hinzufuegen dieselbe globale Block-Liste wie eine DM (``block_exists_
either_way``) — sie gehoert zur selben globalen Identitaets-Schicht, nicht
zu einer einzelnen Community. Ein Self-Host hat weder Freunde noch Blocks;
ohne dieses Gate waere eine Gruppe dort die einzige Stelle, an der ein
Hinzufuegen NICHT gegen eine Blockierung geprueft werden kann.

**Drei Festlegungen, die die Spec ausdruecklich verlangt** (§9 + Plan):

1. **Geht der Ersteller, bleibt die Gruppe** — das dienstaelteste
   verbleibende Mitglied (kleinstes ``beigetreten_am``) erbt die Rolle.
   Begruendung: eine Gruppe, die mit ihrem Gruender verschwindet, nimmt
   allen anderen ihren Verlauf mit — und der liegt ab Etappe C nur noch
   auf Geraeten, es gibt kein Server-Backup, das ihn ersetzen koennte.
   Siehe ``_entferne_mitglied`` unten und
   ``test_ersteller_geht_dienstaeltestes_mitglied_erbt``.
2. **Geht das letzte Mitglied, wird die Gruppe geloescht** — eine Gruppe
   mit null Mitgliedern ist nichts, keine Zeile, die auf niemanden mehr
   zeigt. Siehe ``test_letztes_mitglied_loescht_die_gruppe``.
3. **Blockierte Personen koennen nicht hinzugefuegt werden** — sonst waere
   eine private Gruppe ein Weg, eine Blockierung zu umgehen. Geprueft
   zwischen der hinzufuegenden Person (immer der Ersteller, s. u.) und dem
   Ziel, derselbe Helfer wie ueberall (``block_exists_either_way``).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete as sa_delete
from sqlalchemy import func, select

import dcc_chat_gateway.config as chat_config
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.friend_helpers import block_exists_either_way
from dcc_chat_gateway.models import PrivateGroupChannel, PrivateGroupMember
from dcc_chat_gateway.routes._deps import CloudOnly
from dcc_chat_gateway.schemas import (
    PrivateGroupCreateIn,
    PrivateGroupMemberAddIn,
    PrivateGroupMemberOut,
    PrivateGroupOut,
)
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id


async def require_private_groups_enabled() -> None:
    """FastAPI-Dependency — 403, solange der Schalter aus ist.

    Vorher stand diese Pruefung NUR in ``POST /gruppen`` — die anderen fuenf
    Routen (Liste/Einzelabruf/Hinzufuegen/Entfernen/Verlassen) liefen auch
    bei ausgeschaltetem Schalter ungehindert weiter. Der Schalter garantierte
    damit nur „keine NEUE Gruppe entsteht", nicht „keine Gruppe ist
    erreichbar" — die Spec verlangt aber Letzteres (s. Modul-Docstring).
    Als Router-Dependency neben ``CloudOnly`` kann eine kuenftige Route das
    nicht mehr vergessen: sie muesste die Dependency aktiv abbestellen.

    Later-Import wie bei ``require_cloud`` (``routes/_deps.py``): Test-
    Fixtures ersetzen ``dcc_chat_gateway.config.get_settings`` erst zur
    Aufrufzeit, nicht zur Importzeit."""
    import dcc_chat_gateway.config as _cfg  # noqa: PLC0415

    if not _cfg.get_settings().private_groups_enabled:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="private_groups_disabled")


router = APIRouter(
    tags=["private-gruppen"],
    dependencies=[CloudOnly, Depends(require_private_groups_enabled)],
)


# ─── Laden + Wire-Form ──────────────────────────────────────────────────────


async def _mitglieder_laden(session, gruppe_id: int) -> list[PrivateGroupMember]:
    stmt = select(PrivateGroupMember).where(PrivateGroupMember.gruppe_id == gruppe_id)
    return list((await session.execute(stmt)).scalars())


def _wire(gruppe: PrivateGroupChannel, mitglieder: list[PrivateGroupMember]) -> PrivateGroupOut:
    return PrivateGroupOut(
        id=gruppe.id,
        ersteller_id=gruppe.ersteller_id,
        name=gruppe.name,
        created_at=gruppe.created_at,
        last_message_id=gruppe.last_message_id,
        members=[
            PrivateGroupMemberOut(user_id=m.user_id, beigetreten_am=m.beigetreten_am)
            for m in mitglieder
        ],
    )


async def _gruppe_fuer_mitglied_laden(
    session, gruppe_id: int, user_id: int
) -> tuple[PrivateGroupChannel, PrivateGroupMember]:
    """Laedt die Gruppe NUR, wenn ``user_id`` Mitglied ist — sonst 404, nie
    403: die blosse Existenz einer fremden privaten Gruppe darf ein
    Nichtmitglied nicht erfahren (weder ueber die Liste noch einzeln, s.
    Modul-Docstring Punkt „Nichtmitglied sieht die Gruppe nicht")."""
    eigene = (
        await session.execute(
            select(PrivateGroupMember).where(
                PrivateGroupMember.gruppe_id == gruppe_id,
                PrivateGroupMember.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    if eigene is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="group_not_found")
    gruppe = await session.get(PrivateGroupChannel, gruppe_id)
    if gruppe is None:
        # Kann nur bei einer kaputten Zeile passieren (Mitgliedszeile ohne
        # Gruppe) — CASCADE verhindert das, aber fail-closed statt 500.
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="group_not_found")
    return gruppe, eigene


async def _entferne_mitglied(session, gruppe: PrivateGroupChannel, user_id: int) -> bool:
    """Entfernt ``user_id`` aus ``gruppe`` und setzt die Festlegungen 1+2 aus
    dem Modul-Docstring um. Rueckgabe: ``True``, wenn die Gruppe dabei
    komplett geloescht wurde (letztes Mitglied)."""
    await session.execute(
        sa_delete(PrivateGroupMember).where(
            PrivateGroupMember.gruppe_id == gruppe.id,
            PrivateGroupMember.user_id == user_id,
        )
    )
    verbleibend = await _mitglieder_laden(session, gruppe.id)
    if not verbleibend:
        # Festlegung 2: eine Gruppe mit null Mitgliedern ist nichts.
        await session.delete(gruppe)
        await session.commit()
        return True
    if gruppe.ersteller_id == user_id:
        # Festlegung 1: das dienstaelteste verbleibende Mitglied erbt.
        erbe = min(verbleibend, key=lambda m: (m.beigetreten_am, m.id))
        gruppe.ersteller_id = erbe.user_id
    await session.commit()
    return False


# ─── Routen ─────────────────────────────────────────────────────────────────


@router.post("/gruppen", status_code=status.HTTP_201_CREATED)
async def gruppe_erstellen(
    body: PrivateGroupCreateIn, session: SessionDep, user: CurrentUser
) -> PrivateGroupOut:
    # Der Schalter selbst sitzt seit ``require_private_groups_enabled`` als
    # Router-Dependency (oben) — sie deckt jetzt alle sechs Routen ab, nicht
    # nur diese hier.
    gruppe = PrivateGroupChannel(id=next_id(), ersteller_id=user.id, name=body.name)
    session.add(gruppe)
    session.add(PrivateGroupMember(id=next_id(), gruppe_id=gruppe.id, user_id=user.id))
    await session.commit()
    mitglieder = await _mitglieder_laden(session, gruppe.id)
    return _wire(gruppe, mitglieder)


@router.get("/gruppen")
async def gruppen_auflisten(
    session: SessionDep, user: CurrentUser
) -> list[PrivateGroupOut]:
    stmt = select(PrivateGroupMember.gruppe_id).where(PrivateGroupMember.user_id == user.id)
    gruppe_ids = list((await session.execute(stmt)).scalars())
    if not gruppe_ids:
        return []
    gruppen = (
        await session.execute(
            select(PrivateGroupChannel).where(PrivateGroupChannel.id.in_(gruppe_ids))
        )
    ).scalars().all()
    out: list[PrivateGroupOut] = []
    for gruppe in gruppen:
        mitglieder = await _mitglieder_laden(session, gruppe.id)
        out.append(_wire(gruppe, mitglieder))
    return out


@router.get("/gruppen/{gruppe_id}")
async def gruppe_lesen(
    gruppe_id: int, session: SessionDep, user: CurrentUser
) -> PrivateGroupOut:
    gruppe, _ = await _gruppe_fuer_mitglied_laden(session, gruppe_id, user.id)
    mitglieder = await _mitglieder_laden(session, gruppe.id)
    return _wire(gruppe, mitglieder)


@router.post("/gruppen/{gruppe_id}/mitglieder", status_code=status.HTTP_201_CREATED)
async def mitglied_hinzufuegen(
    gruppe_id: int, body: PrivateGroupMemberAddIn, session: SessionDep, user: CurrentUser
) -> PrivateGroupOut:
    gruppe, _ = await _gruppe_fuer_mitglied_laden(session, gruppe_id, user.id)
    if gruppe.ersteller_id != user.id:
        # Keine Rollen, keine Overwrites — aber auch keine Selbstbedienung:
        # nur wer die Gruppe angelegt hat, darf Mitglieder hinzufuegen.
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="not_the_creator")
    ziel_id = int(body.user_id)

    bereits = (
        await session.execute(
            select(PrivateGroupMember).where(
                PrivateGroupMember.gruppe_id == gruppe_id,
                PrivateGroupMember.user_id == ziel_id,
            )
        )
    ).scalar_one_or_none()
    if bereits is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="already_a_member")

    # Festlegung 3: eine Blockierung in beide Richtungen sperrt das
    # Hinzufuegen — sonst waere die Gruppe ein Weg, sie zu umgehen.
    if await block_exists_either_way(session, user.id, ziel_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="blocked")

    settings = chat_config.get_settings()
    anzahl = (
        await session.execute(
            select(func.count())
            .select_from(PrivateGroupMember)
            .where(PrivateGroupMember.gruppe_id == gruppe_id)
        )
    ).scalar_one()
    if anzahl >= settings.private_group_max_members:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="member_limit_reached")

    session.add(PrivateGroupMember(id=next_id(), gruppe_id=gruppe_id, user_id=ziel_id))
    await session.commit()
    mitglieder = await _mitglieder_laden(session, gruppe_id)
    return _wire(gruppe, mitglieder)


@router.delete("/gruppen/{gruppe_id}/mitglieder/{user_id}")
async def mitglied_entfernen(
    gruppe_id: int, user_id: int, session: SessionDep, user: CurrentUser
) -> PrivateGroupOut | None:
    gruppe, _ = await _gruppe_fuer_mitglied_laden(session, gruppe_id, user.id)
    if gruppe.ersteller_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="not_the_creator")
    ziel_mitglied = (
        await session.execute(
            select(PrivateGroupMember).where(
                PrivateGroupMember.gruppe_id == gruppe_id,
                PrivateGroupMember.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    if ziel_mitglied is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not_a_member")

    geloescht = await _entferne_mitglied(session, gruppe, user_id)
    if geloescht:
        return None
    mitglieder = await _mitglieder_laden(session, gruppe_id)
    return _wire(gruppe, mitglieder)


@router.post("/gruppen/{gruppe_id}/verlassen")
async def gruppe_verlassen(
    gruppe_id: int, session: SessionDep, user: CurrentUser
) -> PrivateGroupOut | None:
    gruppe, _ = await _gruppe_fuer_mitglied_laden(session, gruppe_id, user.id)
    geloescht = await _entferne_mitglied(session, gruppe, user.id)
    if geloescht:
        return None
    mitglieder = await _mitglieder_laden(session, gruppe_id)
    return _wire(gruppe, mitglieder)
