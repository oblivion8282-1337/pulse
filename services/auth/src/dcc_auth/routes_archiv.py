"""Archiv-Schlüssel-Endpunkte (Übergabe 2026-10-04, §5).

* ``GET /me/archiv-schluessel`` — Salt + Passwort-Wrap für den Login-Weg
  des Klienten (der private Schlüssel selbst geht NICHT hier raus).
* ``PUT /me/archiv-schluessel`` — Erstanlage: Klient erzeugt das
  X25519-Paar, wickelt privat unter Argon2id(Passwort) und schickt den
  ROHEN privaten Schlüssel EINMAL mit (TLS) — der Server wickelt ihn
  zusätzlich unter das Schrank-Geheimnis. Danach reist er nie wieder.
* ``PATCH /me/archiv-schluessel`` — Re-Wrap nach Passwortwechsel: nur
  Salt + Passwort-Wrap werden ersetzt (clientseitig neu gewickelt).
* ``GET /internal/archiv-schluessel/pubkey/{user_id}`` — Public-Key für
  chat-gateway (liefert ihn weiter nur an echte DM-Partner).

Der Passwort-RESET wickelt serverseitig neu (``routes_recovery.password_
reset`` → ``rewrap_nach_reset``) — deshalb verliert ein E-Mail-Reset das
Archiv nicht (Entscheidung 03./04.10.).
"""

from __future__ import annotations

import base64
import logging
import os

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.models_archiv import ArchivSchluessel
from dcc_auth.routes import _get_current_user

log = logging.getLogger(__name__)

router = APIRouter()

PUBKEY_LAENGE = 32
PRIVKEY_LAENGE = 32
SALT_LAENGE = 16
# Der Passwort-Wrap: 12-Byte-Nonce + 32-Byte-Schlüssel + 16-Byte-GCM-Tag.
WRAP_KDF_LAENGE = 60


class ArchivSchluesselOut(BaseModel):
    pubkey_b64: str
    kdf_salt_b64: str
    wrap_kdf_b64: str


class ArchivSchluesselAnlage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    pubkey_b64: str = Field(min_length=40, max_length=64)
    kdf_salt_b64: str = Field(min_length=20, max_length=32)
    wrap_kdf_b64: str = Field(min_length=40, max_length=128)
    # Der rohe private Schlüssel — NUR in diesem einen Aufruf (TLS), damit
    # der Server den Schrank-Wrap rechnen kann. Danach nie wieder unterwegs.
    privkey_b64: str = Field(min_length=40, max_length=64)


class ArchivSchluesselRewrap(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kdf_salt_b64: str = Field(min_length=20, max_length=32)
    wrap_kdf_b64: str = Field(min_length=40, max_length=128)


def _b64d(wert: str, laenge: int, feld: str) -> bytes:
    try:
        raw = base64.b64decode(wert, validate=True)
    except Exception:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, detail=f"bad_base64:{feld}"
        ) from None
    if len(raw) != laenge:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, detail=f"bad_length:{feld}"
        )
    return raw


def _b64e(raw: bytes) -> str:
    return base64.b64encode(raw).decode()


@router.get("/me/archiv-schluessel", response_model=ArchivSchluesselOut)
async def archiv_schluessel_lesen(
    session: SessionDep,
    current=Depends(_get_current_user),
) -> ArchivSchluesselOut:
    zeile = (
        await session.execute(
            select(ArchivSchluessel).where(ArchivSchluessel.user_id == current.id)
        )
    ).scalar_one_or_none()
    if zeile is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="archiv_schluessel_fehlt")
    return ArchivSchluesselOut(
        pubkey_b64=_b64e(zeile.pubkey),
        kdf_salt_b64=_b64e(zeile.kdf_salt),
        wrap_kdf_b64=_b64e(zeile.wrap_kdf),
    )


@router.put("/me/archiv-schluessel", status_code=status.HTTP_204_NO_CONTENT)
async def archiv_schluessel_anlegen(
    payload: ArchivSchluesselAnlage,
    session: SessionDep,
    current=Depends(_get_current_user),
) -> None:
    """Erstanlage — existiert schon eine Zeile, ist es 409: der Public-Key
    eines Kontos ist unveränderlich ohne den Re-Wrap-Weg, sonst würden
    alte Archiv-Kanal-Wraps still unlesbar."""
    if (
        await session.execute(
            select(ArchivSchluessel.user_id).where(ArchivSchluessel.user_id == current.id)
        )
    ).scalar_one_or_none() is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="archiv_schluessel_exists")
    wrap_schrank = schranke_privkey(_b64d(payload.privkey_b64, PRIVKEY_LAENGE, "privkey"))
    session.add(
        ArchivSchluessel(
            user_id=current.id,
            pubkey=_b64d(payload.pubkey_b64, PUBKEY_LAENGE, "pubkey"),
            kdf_salt=_b64d(payload.kdf_salt_b64, SALT_LAENGE, "kdf_salt"),
            wrap_kdf=_b64d(payload.wrap_kdf_b64, WRAP_KDF_LAENGE, "wrap_kdf"),
            wrap_schrank=wrap_schrank,
        )
    )
    await session.commit()


@router.patch("/me/archiv-schluessel", status_code=status.HTTP_204_NO_CONTENT)
async def archiv_schluessel_rewrap(
    payload: ArchivSchluesselRewrap,
    session: SessionDep,
    current=Depends(_get_current_user),
) -> None:
    """Passwortwechsel: nur Salt + Passwort-Wrap tauschen — der Public-Key
    und alle Kanal-Wraps bleiben, das Archiv verliert nichts."""
    zeile = (
        await session.execute(
            select(ArchivSchluessel).where(ArchivSchluessel.user_id == current.id)
        )
    ).scalar_one_or_none()
    if zeile is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="archiv_schluessel_fehlt")
    zeile.kdf_salt = _b64d(payload.kdf_salt_b64, SALT_LAENGE, "kdf_salt")
    zeile.wrap_kdf = _b64d(payload.wrap_kdf_b64, WRAP_KDF_LAENGE, "wrap_kdf")
    await session.commit()


@router.get("/internal/archiv-schluessel/pubkey/{user_id}")
async def archiv_pubkey_intern(
    user_id: int,
    session: SessionDep,
    x_pulse_internal_secret: str | None = Header(default=None),
) -> dict[str, str | None]:
    """Public-Key-Auskunft für chat-gateway (das sie nur an echte
    DM-Partner ausliefert)."""
    from dcc_auth.routes_complaints import _check_internal_secret

    _check_internal_secret(x_pulse_internal_secret)
    pubkey = (
        await session.execute(
            select(ArchivSchluessel.pubkey).where(ArchivSchluessel.user_id == user_id)
        )
    ).scalar_one_or_none()
    return {"pubkey_b64": _b64e(pubkey) if pubkey is not None else None}


def schranke_privkey(privkey: bytes) -> bytes:
    """AES-256-GCM unter dem Schrank-Geheimnis (12-Byte-Nonce vorn).
    Schlüssel kommt als base64(32 Bytes) aus der Umgebung."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    settings = get_settings()
    geheimnis = settings.archiv_schrank_secret
    if not geheimnis:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="archiv_schrank_secret unset",
        )
    try:
        schluessel = base64.b64decode(geheimnis, validate=True)
    except Exception:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="archiv_schrank_secret bad base64",
        ) from None
    if len(schluessel) != PRIVKEY_LAENGE:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="archiv_schrank_secret muss 32 Bytes (base64) sein",
        )
    nonce = os.urandom(12)
    return nonce + AESGCM(schluessel).encrypt(nonce, privkey, b"pulse-archiv-schrank")


def entsperre_privkey(wrap_schrank: bytes) -> bytes:
    """Gegenstück zu ``schranke_privkey`` — NUR der Reset-Weg benutzt das."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    settings = get_settings()
    geheimnis = settings.archiv_schrank_secret
    if not geheimnis:
        raise RuntimeError("archiv_schrank_secret unset")
    schluessel = base64.b64decode(geheimnis, validate=True)
    return AESGCM(schluessel).decrypt(
        wrap_schrank[:12], wrap_schrank[12:], b"pulse-archiv-schrank"
    )


# Argon2id-Parameter — MÜSSEN exakt den Klienten-Vorgaben entsprechen
# (web/src/lib/sicherung/krypto.ts: t=3, m=64 MiB, p=1, 32 Bytes), sonst
# öffnet der Klient den nach einem Reset neu gewickelten Schlüssel nicht.
ARGON_ZEITEN = 3
ARGON_SPEICHER_KIB = 64 * 1024
ARGON_PARALLELITAET = 1


async def rewrap_nach_reset(session: AsyncSession, user_id: int, neues_passwort: str) -> None:
    """Nach einem Passwort-RESET: privaten Schlüssel aus dem Schrank holen
    und unter das NEUE Passwort neu wickeln — das Archiv verliert nichts.
    Schrank-Geheimnis nicht gesetzt (Dev): Zeile stehen lassen und laut
    warnen — der Klient behandelt eine fehlgeschlagene Entsperrung als
    „kein Archiv“ und richtet bei Bedarf neu ein."""
    from argon2.low_level import Type, hash_secret_raw

    zeile = (
        await session.execute(
            select(ArchivSchluessel).where(ArchivSchluessel.user_id == user_id)
        )
    ).scalar_one_or_none()
    if zeile is None:
        return
    try:
        privkey = entsperre_privkey(zeile.wrap_schrank)
    except Exception:  # noqa: BLE001 — falsches Geheimnis/Zeile: laut melden
        log.error("archiv_rewrap: Schrank-Wrap %s unlesbar — Archiv-Zugang geht verloren", user_id)
        return
    salt = os.urandom(SALT_LAENGE)
    kek = hash_secret_raw(
        secret=neues_passwort.encode(),
        salt=salt,
        time_cost=ARGON_ZEITEN,
        memory_cost=ARGON_SPEICHER_KIB,
        parallelism=ARGON_PARALLELITAET,
        hash_len=PRIVKEY_LAENGE,
        type=Type.ID,
    )
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    nonce = os.urandom(12)
    zeile.kdf_salt = salt
    zeile.wrap_kdf = nonce + AESGCM(kek).encrypt(nonce, privkey, b"pulse-archiv-kdf")
    # Kein Commit — der Reset-Ablauf committet seinen Zug einmal (Muster
    # „Committet nicht selbst“, wie die Sweep-Läufe im chat-gateway).
