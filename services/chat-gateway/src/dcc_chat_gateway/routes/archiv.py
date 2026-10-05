"""Archiv-Routen für DM- und Gruppen-Verlauf (Übergabe 2026-10-04, §5;
Gruppen seit 2026-10-05 — Michaels Entscheidung „Gruppen und Privatchats").

Der Server lagert verschlüsselte Textzeilen (AES-256-GCM unter einem
Kanal-Schlüssel, den er selbst nie sieht) und die Kanal-Schlüssel-Wraps.
Er entscheidet nur über Mitgliedschaft — lesen und schreiben kann nur,
wer im Kanal ist (DM oder private Gruppe). Der private Archiv-Schlüssel
der Konten lebt beim auth-Dienst (``archiv_schluessel``, zweifach
gewrappt); hier liegen nur öffentliche Wirkungen davon (die Wraps an
Public-Keys).

**Gruppen und Beitragsgrenze.** Ein Mitglied einer privaten Gruppe liest
nur Zeilen ab seinem eigenen Beitritt (``beigetreten_am``) — dasselbe
Fenster, das Megolm ihm live zeigt. Der Kanal-Schlüssel selbst öffnet
auch ältere Zeilen; die Zeilen werden ihm nur nicht ausgeliefert
(ponytail: Durchsetzung am Auslieferungspunkt, keine Schlüssel-Rotation
je Mitgliederwechsel — Upgrade-Pfad wäre eine Schlüssel-Epoche je Sitzung
wie bei Megolm).

Bewusste Grenzen (ponytail): keine Volltextsuche, keine Löschanfrage je
Zeile — der 120-Tage-Sweeper räumt.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import NamedTuple

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import (
    ARCHIV_VORHALTE_TAGE,
    ArchivKanalSchluessel,
    ArchivZeile,
    DirectMessageChannel,
    PrivateGroupMember,
)
from dcc_chat_gateway.private_gruppen_zugriff import gruppen_teilnehmer
from dcc_chat_gateway.routes._deps import CloudOnly, dm_member_check
from dcc_chat_gateway.security import CurrentUser

log = logging.getLogger(__name__)

router = APIRouter(dependencies=[CloudOnly])

# Deckel je Abruf: ein Gesprächsjahr liegt bei ein paar tausend Zeilen;
# der Klient blättert mit ``vor_id`` nach. Grob an den Postfach-Batch
# angelehnt, kein hartes Limit-Studio.
MAX_ZEILEN_JE_ABRUF = 500
MAX_ZEILEN_JE_EINLIEFERUNG = 2000


class ArchivZeileIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Id vom Klienten (Zufalls-Snowflake): Wiederholung nach Netzfehler ist
    # idempotent (ON CONFLICT DO NOTHING), statt Duplikate zu stapeln.
    id: int = Field(gt=0)
    channel_id: int = Field(gt=0)
    nutzlast_b64: str = Field(min_length=8, max_length=32768)


class ArchivWrapIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    channel_id: int = Field(gt=0)
    user_id: int = Field(gt=0)
    wrap_b64: str = Field(min_length=16, max_length=512)


class ArchivEinlieferung(BaseModel):
    model_config = ConfigDict(extra="forbid")

    zeilen: list[ArchivZeileIn] = Field(max_length=MAX_ZEILEN_JE_EINLIEFERUNG)
    wraps: list[ArchivWrapIn] = Field(max_length=100)


class ArchivZeileOut(BaseModel):
    id: str
    channel_id: str
    nutzlast_b64: str
    erstellt_at: str


class ArchivZugriff(NamedTuple):
    """Wer in diesem Kanal Archiv-Zeilen sehen darf, plus die Lese-Grenze.

    ``beigetreten_am`` ist nur bei privaten Gruppen gesetzt — ein Mitglied
    liest ab seinem Beitritt; DM-Teilnehmer waren von Beginn dabei
    (``None`` = unbegrenzt)."""

    teilnehmer: set[int]
    beigetreten_am: datetime | None


def _bewusst_utc(zeit: datetime) -> datetime:
    """SQLite (Tests) liefert naive Stempel, Postgres tz-bewusste — hier
    zusammenbringen, sonst scheitert der Beitritts-Vergleich im Testlauf."""
    return zeit if zeit.tzinfo is not None else zeit.replace(tzinfo=UTC)


async def _archiv_zugriff(session, channel_id: int, user_id: int) -> ArchivZugriff:
    """DM oder private Gruppe — alles andere ist 404 (kein Bestehen-Leak,
    derselbe Grund wie bei ``_channel_zugriff_pruefen``)."""
    dm = await dm_member_check(session, channel_id, user_id)
    if dm is not None:
        return ArchivZugriff(teilnehmer={dm.user_a_id, dm.user_b_id}, beigetreten_am=None)
    mitglieder = await gruppen_teilnehmer(session, channel_id, user_id)
    if mitglieder is not None:
        beitritt = (
            await session.execute(
                select(PrivateGroupMember.beigetreten_am).where(
                    PrivateGroupMember.gruppe_id == channel_id,
                    PrivateGroupMember.user_id == user_id,
                )
            )
        ).scalar_one()
        return ArchivZugriff(teilnehmer=mitglieder, beigetreten_am=_bewusst_utc(beitritt))
    raise HTTPException(status.HTTP_404_NOT_FOUND, detail="dm_channel_not_found")


async def _pruefe_zeilen_kanaele(
    session, channel_ids: set[int], user_id: int
) -> dict[int, ArchivZugriff]:
    """Alle Kanäle einer Einlieferung müssen DMs oder private Gruppen des
    Aufrufers sein — die Zugriffe kommen zurück, die Wrap-Schleife braucht
    sie erneut."""
    zugriffe: dict[int, ArchivZugriff] = {}
    for cid in channel_ids:
        zugriffe[cid] = await _archiv_zugriff(session, cid, user_id)
    return zugriffe


@router.post("/archiv", status_code=status.HTTP_204_NO_CONTENT)
async def archiv_einliefern(
    payload: ArchivEinlieferung,
    session: SessionDep,
    current: CurrentUser,
) -> None:
    if not payload.zeilen and not payload.wraps:
        return
    kanaele = {z.channel_id for z in payload.zeilen} | {w.channel_id for w in payload.wraps}
    zugriffe = await _pruefe_zeilen_kanaele(session, kanaele, current.id)

    for zeile in payload.zeilen:
        await session.execute(
            pg_insert(ArchivZeile)
            .values(
                id=zeile.id,
                channel_id=zeile.channel_id,
                nutzlast=_b64(zeile.nutzlast_b64),
            )
            .on_conflict_do_nothing(index_elements=[ArchivZeile.id])
        )
    for wrap in payload.wraps:
        zugriff = zugriffe[wrap.channel_id]
        if wrap.user_id != current.id and wrap.user_id not in zugriff.teilnehmer:
            # Der Absender wickelt nur an Kanal-Teilnehmer — fremde user_ids
            # wären ein Weg, Zeilen für Dritte zu hinterlegen.
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="dm_channel_not_found")
        await session.execute(
            pg_insert(ArchivKanalSchluessel)
            .values(
                channel_id=wrap.channel_id,
                user_id=wrap.user_id,
                wrap=_b64(wrap.wrap_b64),
            )
            .on_conflict_do_nothing(
                index_elements=[ArchivKanalSchluessel.channel_id, ArchivKanalSchluessel.user_id]
            )
        )
    await session.commit()


@router.get("/archiv/pubkeys")
async def archiv_pubkeys(
    session: SessionDep,
    current: CurrentUser,
    user_ids: str = Query(min_length=1, max_length=256),
    channel_id: int | None = Query(default=None, description="Skop: Kanal-Mitglieder statt DM-Partner"),
) -> dict[str, str | None]:
    """Archiv-Public-Keys — NUR für Konten, mit denen man wirklich schreibt:
    mit ``channel_id`` für Mitspieler in DIESEM Kanal (DM oder private
    Gruppe — Gruppen-Sendungen brauchen die Keys aller Mitglieder), ohne
    für DM-Partner (Altweg der Renderer vor der Gruppen-Erweiterung). Ein
    Abfragen beliebiger Konten wäre ein Metadaten-Orakel (wer hat das
    Archiv je eingerichtet)."""
    try:
        ids = {int(t) for t in user_ids.split(",") if t.strip()}
    except ValueError:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="bad_user_ids") from None
    if not ids or len(ids) > 50:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="bad_user_ids")
    ergebnis: dict[str, str | None] = {}
    if channel_id is not None:
        zugriff = await _archiv_zugriff(session, channel_id, current.id)
        erlaubt = zugriff.teilnehmer | {current.id}
        if not ids <= erlaubt:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="dm_channel_not_found")
        for uid in ids:
            ergebnis[str(uid)] = await _auth_pubkey(uid)
        return ergebnis
    for uid in ids:
        dm = await session.execute(
            select(DirectMessageChannel.id).where(
                (
                    (DirectMessageChannel.user_a_id == current.id)
                    & (DirectMessageChannel.user_b_id == uid)
                )
                | (
                    (DirectMessageChannel.user_a_id == uid)
                    & (DirectMessageChannel.user_b_id == current.id)
                )
            ).limit(1)
        )
        if dm.scalar_one_or_none() is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="dm_channel_not_found")
        ergebnis[str(uid)] = await _auth_pubkey(uid)
    return ergebnis



@router.get("/archiv/{channel_id}", response_model=list[ArchivZeileOut])
async def archiv_lesen(
    channel_id: int,
    session: SessionDep,
    current: CurrentUser,
    vor_id: int | None = Query(default=None, description="nur Zeilen mit id < vor_id"),
    limit: int = Query(default=MAX_ZEILEN_JE_ABRUF, le=MAX_ZEILEN_JE_ABRUF, ge=1),
) -> list[ArchivZeileOut]:
    zugriff = await _archiv_zugriff(session, channel_id, current.id)
    stmt = (
        select(ArchivZeile)
        .where(ArchivZeile.channel_id == channel_id)
        .order_by(ArchivZeile.id.desc())
        .limit(limit)
    )
    if vor_id is not None:
        stmt = stmt.where(ArchivZeile.id < vor_id)
    zeilen = (await session.execute(stmt)).scalars().all()
    # Private Gruppe: nur ab dem eigenen Beitritt — dasselbe Fenster, das
    # Megolm dem Mitglied live zeigt (s. Modulkopf). Vergleich in Python,
    # nicht im SQL: SQLite (Tests) speichert CURRENT_TIMESTAMP ohne
    # Mikrosekunden und bricht am String-Vergleich bei gleicher Sekunde.
    # Die Sichtbarkeit ist ein Nachsatz der Zeitachse — ein gefiltert
    # leeres Blatt heißt deshalb wirklich „ausgelesen“, Pagination bleibt
    # sicher.
    if zugriff.beigetreten_am is not None:
        zeilen = [
            z for z in zeilen if _bewusst_utc(z.erstellt_at) >= zugriff.beigetreten_am
        ]
    return [
        ArchivZeileOut(
            id=str(z.id),
            channel_id=str(z.channel_id),
            nutzlast_b64=_zu_b64(z.nutzlast),
            erstellt_at=z.erstellt_at.isoformat(),
        )
        for z in reversed(zeilen)  # aufsteigend ausliefern — der Klient hängt an
    ]


@router.get("/archiv/{channel_id}/schluessel")
async def archiv_kanal_schluessel(
    channel_id: int,
    session: SessionDep,
    current: CurrentUser,
) -> dict[str, str | None]:
    """Der eigene Kanal-Schlüssel-Wrap — ohne ihn ist der Kanal unreadable
    (fail-closed): NULL heißt „noch keiner für mich hinterlegt“."""
    await _archiv_zugriff(session, channel_id, current.id)
    wrap = (
        await session.execute(
            select(ArchivKanalSchluessel.wrap).where(
                ArchivKanalSchluessel.channel_id == channel_id,
                ArchivKanalSchluessel.user_id == current.id,
            )
        )
    ).scalar_one_or_none()
    return {"wrap_b64": _zu_b64(wrap) if wrap is not None else None}


async def _auth_pubkey(uid: int) -> str | None:
    """Holt den Public-Key beim auth-Dienst (dort lebt die Tabelle
    ``archiv_schluessel``). Best-effort: ohne Key wird nicht archiviert,
    der Verlauf lebt im lokalen Bestand weiter."""
    import httpx

    from dcc_chat_gateway.config import get_settings

    settings = get_settings()
    secret = settings.internal_service_secret
    if not secret:
        return None
    url = settings.auth_svc_url.rstrip("/") + f"/internal/archiv-schluessel/pubkey/{uid}"
    try:
        async with httpx.AsyncClient(timeout=settings.auth_svc_timeout_s) as http:
            resp = await http.get(url, headers={"X-Pulse-Internal-Secret": secret})
        if resp.status_code != 200:
            return None
        return resp.json().get("pubkey_b64")
    except httpx.HTTPError as exc:
        log.warning("archiv_pubkey_lookup fehlgeschlagen: %s", exc)
        return None


def _b64(wert: str) -> bytes:
    import base64

    try:
        return base64.b64decode(wert, validate=True)
    except Exception:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="bad_base64") from None


def _zu_b64(bytes_: bytes | None) -> str | None:
    import base64

    return base64.b64encode(bytes_).decode() if bytes_ is not None else None


async def sweep_abgelaufene_archiv_zeilen(session, vorhalte_tage: int = ARCHIV_VORHALTE_TAGE) -> int:
    """Löscht Archiv-Zeilen, deren Vorhaltezeit (120 Tage ab Versand) um ist."""
    from datetime import datetime, timedelta

    grenze = datetime.now(tz=UTC) - timedelta(days=vorhalte_tage)
    res = await session.execute(delete(ArchivZeile).where(ArchivZeile.erstellt_at < grenze))
    return res.rowcount or 0
