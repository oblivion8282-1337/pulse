"""Widerruf von Geraete-Zertifikaten — eine Stelle fuer alle Wege.

Bis hierher gab es den Widerruf nur als Selbstbedienung des Nutzers
(``POST /credentials/{cert_id}/revoke``). Weder die Kontoloeschung noch die
Admin-Sperre riefen ihn — beide Wege liessen ein ausgestelltes Zertifikat
unangetastet, und ein Self-Host prueft ein Zertifikat ausschliesslich gegen
Signatur und Sperrliste. Der Bann erreichte damit keinen einzigen Self-Host,
und die Kontoloeschung machte den Widerruf sogar dauerhaft unmoeglich (die
Kaskade nimmt die Zeile mit, die die ``cert_id`` traegt).

Der Widerruf besteht deshalb aus **zwei** Schritten, und nur zusammen halten
sie die Zusage:

1. ``revoked_at`` in ``issued_credentials`` stempeln — solange die Zeile lebt,
   ist das die Quelle fuer Listen und Neuausstellung.
2. Einen **Grabstein** in ``revoked_credentials`` schreiben (siehe
   ``models_credentials.RevokedCredential``). Er haengt an keinem
   Fremdschluessel und ueberlebt die Kaskade der Kontoloeschung. Nur er macht
   die Zusage "einmal widerrufen, bis zum Ablauf gesperrt" haltbar.

Die Redis-Sperrliste (schneller Weg der veroeffentlichten CRL) wird erst
**nach** dem Commit beschickt — ``publish_revocations``. Rollt die Transaktion
zurueck, ist auch nichts gemeldet.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import dcc_auth.config as _config
from dcc_auth.models import IssuedCredential, RevokedCredential

log = logging.getLogger(__name__)

# Etiketten fuer ``revoked_credentials.reason`` — reine Nachschau-Hilfe.
REASON_USER_REVOKE = "user_revoke"
REASON_REISSUE = "reissue"
REASON_ACCOUNT_DELETE = "account_delete"
REASON_ADMIN_DISABLE = "admin_disable"

# (cert_id, expires_at) — was nach dem Commit in die Sperrliste gehoert.
Revocation = tuple[str, datetime]


def as_utc(value: datetime) -> datetime:
    """Naive Zeitstempel (SQLite liefert sie so) als UTC lesen.

    Ohne das deutet ``.timestamp()`` sie als Ortszeit und der Score im ZSET
    verschoebe sich um den UTC-Abstand — ein Widerruf fiele bis zu Stunden zu
    frueh oder zu spaet aus der Sperrliste.
    """
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


async def record_revocation(
    session: AsyncSession,
    cert_id: str,
    expires_at: datetime,
    *,
    reason: str,
    revoked_at: datetime | None = None,
) -> Revocation:
    """Grabstein schreiben (idempotent) und den Sperrlisten-Eintrag liefern.

    Idempotent, weil derselbe Pass ueber zwei Wege gleichzeitig fallen kann
    (Nutzer widerruft von Hand, waehrend der Admin sperrt) — der zweite Aufruf
    darf nicht am Primaerschluessel scheitern und die ganze Transaktion
    mitreissen.
    """
    exp = as_utc(expires_at)
    if await session.get(RevokedCredential, cert_id) is None:
        session.add(
            RevokedCredential(
                cert_id=cert_id,  # type: ignore[arg-type]
                expires_at=exp,
                revoked_at=revoked_at or datetime.now(UTC),
                reason=reason,
            )
        )
    return cert_id, exp


async def revoke_credentials_for_user(
    session: AsyncSession,
    user_id: int,
    *,
    reason: str,
    now: datetime | None = None,
) -> list[Revocation]:
    """Alle noch gueltigen Zertifikate eines Nutzers widerrufen.

    Bereits abgelaufene Zeilen bleiben aussen vor: ein Self-Host weist sie
    schon an ``exp`` ab, ein Grabstein waere nur Ballast in der Sperrliste.

    Committet **nicht** — der Aufrufer entscheidet, ob der Widerruf Teil
    seiner Transaktion ist (bei der Kontoloeschung muss er das sein, sonst
    haette man widerrufen ohne zu loeschen oder umgekehrt). Der Rueckgabewert
    gehoert nach dem Commit in ``publish_revocations``.
    """
    at = now or datetime.now(UTC)
    rows = (
        await session.execute(
            select(IssuedCredential).where(
                IssuedCredential.user_id == user_id,
                IssuedCredential.revoked_at.is_(None),
                IssuedCredential.expires_at > at,
            )
        )
    ).scalars().all()

    revoked: list[Revocation] = []
    for cred in rows:
        cred.revoked_at = at
        revoked.append(
            await record_revocation(
                session,
                str(cred.cert_id),
                cred.expires_at,
                reason=reason,
                revoked_at=at,
            )
        )
    if revoked:
        await session.flush()
    return revoked


async def publish_revocations(revoked: Sequence[Revocation]) -> None:
    """Best-effort: die widerrufenen Kennungen in die Redis-Sperrliste schieben.

    Best-effort ist vertretbar, weil der Grabstein in der Datenbank die
    dauerhafte Quelle ist: der CRL-Endpunkt fuellt ein leeres ZSET aus ihr
    nach (``routes_crl``). Ein Redis-Ausfall verzoegert den Widerruf also,
    er verliert ihn nicht.
    """
    if not revoked:
        return
    try:
        from redis.asyncio import Redis

        from dcc_auth.routes_crl import crl_add

        # Modul-Zugriff statt importiertem Namen: die Test-Fixture tauscht
        # ``dcc_auth.config.get_settings`` aus, ein früh importierter Name
        # zeigte weiter auf die echte Konfiguration.
        redis_url = _config.get_settings().redis_url
        if not redis_url:
            return
        async with Redis.from_url(redis_url, decode_responses=True) as r:
            for cert_id, expires_at in revoked:
                await crl_add(r, cert_id, int(as_utc(expires_at).timestamp()))
    except Exception:  # noqa: BLE001
        # Kein cert_id ins Log — die Sperrliste veroeffentlicht sie ohnehin,
        # aber ein Logfile ist der falsche Ort dafuer.
        log.warning("redis CRL push failed for %d credential(s)", len(revoked))


__all__ = [
    "REASON_ACCOUNT_DELETE",
    "REASON_ADMIN_DISABLE",
    "REASON_REISSUE",
    "REASON_USER_REVOKE",
    "Revocation",
    "as_utc",
    "publish_revocations",
    "record_revocation",
    "revoke_credentials_for_user",
]
