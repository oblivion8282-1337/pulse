"""Kopplung von Refresh-Token und Browser-Session-Cookie — eine Sitzung, zwei Haelften.

Warum es diese Datei gibt
-------------------------
Eine Anmeldung erzeugt zwei Berechtigungen mit verschiedenen Lebensdauern:

* den **Refresh-Token** (``auth.refresh_tokens``, Tage bis Wochen) — er haelt
  den Zugriffstoken frisch;
* das **Browser-Session-Cookie** (``auth.user_sessions``, 30 Minuten
  gleitend) — an ihm haengen die cookie-only-Endpunkte, allen voran
  ``POST /credentials/issue``, das Geraete-Zertifikate ausstellt.

Die Sitzungsliste zeigt nur die erste Haelfte. "Sitzung beenden" beendete
deshalb auch nur diese: das Geraet blieb ueber sein Cookie voll angemeldet und
konnte sich sogar noch ein frisches Identitaets-Zertifikat ausstellen — eine
Zusage, die nicht stimmte. ``refresh_tokens.session_id`` (Migration 0049)
traegt seither die Verbindung, und die Funktionen hier sind die einzige Stelle,
die sie herstellt, weiterreicht und einloest.

Was hier **nicht** passiert: Geraete-Zertifikate widerrufen. Das Zertifikat
haengt am Geraet, nicht an der Sitzung — es lebt bis zu 365 Tage, ueberdauert
jede Ab- und Neuanmeldung und hat mit ``/credentials/list`` plus
``POST /credentials/{cert_id}/revoke`` einen eigenen, sichtbaren Widerrufsweg.
Ein Sitzungsende, das ungefragt Zertifikate mitnimmt, wuerde einem Nutzer, der
nur ein fremdes Fenster schliessen wollte, still die Identitaet auf allen
Self-Hosts entziehen. Was das Sitzungsende sicherstellen MUSS, ist, dass die
beendete Sitzung keine NEUEN Zertifikate mehr ausstellen kann — und genau das
leistet der Cookie-Widerruf hier, weil ``/credentials/issue`` ohne gueltiges
Cookie nicht laeuft.
"""

from __future__ import annotations

import hashlib
import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy import update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_auth.models import RefreshToken, UserSession


def as_sid(value: uuid.UUID | str | None) -> str | None:
    """Sitzungskennung als Zeichenkette — der Bindewert beider Datenbanken.

    ``user_sessions.session_id`` ist auf Postgres ein UUID-Typ und auf der
    SQLite-Testdatenbank TEXT; ``create_session`` bindet dort schon immer die
    Zeichenkette. Wer hier einen ``uuid.UUID`` durchreicht, bekommt auf SQLite
    stillschweigend keinen Treffer.
    """
    return None if value is None else str(value)


def parse_sid(raw: str | None) -> str | None:
    """Rohen Cookie-Wert pruefen und normalisieren (``None`` bei Unsinn)."""
    if not raw:
        return None
    try:
        return str(uuid.UUID(raw))
    except ValueError:
        return None


async def _session_alive(db: AsyncSession, sid: str | None, now: datetime) -> bool:
    if sid is None:
        return False
    row = await db.get(UserSession, sid)
    if row is None or row.revoked_at is not None:
        return False
    exp = row.expires_at if row.expires_at.tzinfo else row.expires_at.replace(tzinfo=UTC)
    return exp > now


async def revoke_sessions(
    db: AsyncSession, session_ids: list[str], *, now: datetime | None = None
) -> int:
    """Die genannten Cookie-Zeilen entwerten. Committet nicht.

    Es werden ``expires_at`` UND ``revoked_at`` gesetzt: der Widerruf ist eine
    Sicherheitsentscheidung, kein Ablauf. ``validate_session`` weist eine
    widerrufene Zeile sofort ab, und ``/session/renew`` erbt ihren
    Anmeldekontext (acr/amr) nicht mehr.
    """
    ids = [s for s in session_ids if s]
    if not ids:
        return 0
    at = now or datetime.now(UTC)
    result = await db.execute(
        sa_update(UserSession)
        .where(UserSession.session_id.in_(ids), UserSession.revoked_at.is_(None))
        .values(expires_at=at, revoked_at=at)
    )
    return result.rowcount or 0


async def revoke_sessions_of_tokens(
    db: AsyncSession,
    tokens: list[RefreshToken],
    *,
    now: datetime | None = None,
) -> int:
    """Die Cookies der genannten Refresh-Token beenden.

    Gemeinsamer Weg fuer alle Stellen, die Refresh-Token entwerten: Einzel-
    Widerruf, Abmelden und die Wiederverwendungs-Erkennung in ``/refresh``.
    """
    return await revoke_sessions(
        db, [as_sid(t.session_id) or "" for t in tokens], now=now
    )


async def revoke_session_of_token_fallback(
    db: AsyncSession,
    rt: RefreshToken,
    *,
    keep_sid: str | None,
    now: datetime | None = None,
) -> int:
    """Notbehelf fuer Refresh-Token OHNE Verknuepfung (Zeilen von vor 0049).

    Solche Zeilen kennen ihr Cookie nicht mehr; die Migration hat sie
    ausdruecklich nicht geraten. Bleibt der Vergleich ueber Browser-Kennstring
    und IP-Pruefsumme — dieselbe Kennzeichnung, die die Sitzungsliste schon
    fuer ihr "dieses Geraet"-Abzeichen benutzt. ``user_sessions`` speichert die
    IP im Klartext, ``refresh_tokens`` nur ihre SHA-256-Pruefsumme; verglichen
    wird deshalb Pruefsumme gegen Pruefsumme.

    Zwei bewusste Grenzen:

    * ``keep_sid`` (das Cookie des Aufrufers) bleibt IMMER verschont. Der
      Vergleich kann zwei Geraete hinter derselben Adresse mit demselben
      Browser nicht auseinanderhalten — ein Fehltreffer wuerde sonst den
      Aufrufer aus dem Fenster werfen, in dem er gerade klickt.
    * Wandert ein Geraet ins naechste Netz, passt die Pruefsumme nicht mehr
      (der Refresh-Token bekommt bei jeder Rotation die neue Adresse, die
      Cookie-Zeile behaelt die vom Anmelden). Dann greift der Notbehelf nicht.
      Das ist der Preis dafuer, nicht zu raten — und er faellt weg, sobald das
      Geraet sich einmal neu anmeldet oder seinen Token rotiert.
    """
    if rt.session_id is not None or rt.ip_hash is None:
        return 0
    at = now or datetime.now(UTC)
    rows = (
        await db.execute(
            select(UserSession).where(
                UserSession.user_id == rt.user_id,
                UserSession.revoked_at.is_(None),
            )
        )
    ).scalars().all()
    hits: list[str] = []
    for row in rows:
        sid = as_sid(row.session_id)
        if sid is None or sid == keep_sid or row.ip is None:
            continue
        if hashlib.sha256(str(row.ip).encode("utf-8")).hexdigest() != rt.ip_hash:
            continue
        if _short_ua(row.user_agent) != _short_ua(rt.user_agent):
            continue
        hits.append(sid)
    return await revoke_sessions(db, hits, now=at)


def _short_ua(value: str | None) -> str | None:
    """``user_sessions`` schneidet den Kennstring bei 2000, ``refresh_tokens``
    bei 1000 Zeichen ab — fuer den Vergleich zaehlt die kuerzere Fassung."""
    return (value[:1000] if value else None) or None


async def relink_to_new_session(
    db: AsyncSession,
    *,
    user_id: int,
    old_sid: str | None,
    new_sid: str,
    user_agent: str | None,
    now: datetime | None = None,
) -> int:
    """Beim Erneuern des Cookies (``/session/renew``) die Token umhaengen.

    ``renew`` legt ein neues Cookie an, ohne die Refresh-Token anzufassen.
    Ohne das Umhaengen zeigte die Verknuepfung danach auf die tote Vorgaenger-
    Zeile, und "Sitzung beenden" liefe wieder ins Leere — genau der Fall der
    Desktop-App, die nach jedem Neustart erneuert.

    Zwei Wege, weil ``renew`` beides zulaesst:

    * **Mit Cookie**: die Vorgaengerkennung ist bekannt, das Umhaengen ist
      exakt. Die alte Zeile wird vom Aufrufer anschliessend entwertet.
    * **Nur mit Zugriffstoken** (Desktop nach Neustart, Cookie laengst
      abgelaufen): umgehaengt werden nur Token, deren Verknuepfung ins Leere
      zeigt — fehlend, geloescht, abgelaufen oder widerrufen. Eine lebende
      Verknuepfung eines anderen Geraets wird nie angetastet. Bleiben mehrere
      verwaiste Token mit demselben Browser-Kennstring uebrig, erben sie alle
      dasselbe neue Cookie; das beendet im Zweifel eine Sitzung zu viel und
      nie eine zu wenig.

      Dass "lebende Verknuepfung ueberspringen" hier richtig ist, haengt an
      einer Eigenschaft des Cookies: der Browser schickt es von selbst mit.
      Wer OHNE Cookie erneuert, hat keins mehr — eine noch lebende Zeile am
      eigenen Token gehoert dann fast sicher einem anderen Geraet mit
      demselben Kennstring, und dem duerfen wir sein Cookie nicht wegnehmen.
    """
    at = now or datetime.now(UTC)
    if old_sid is not None:
        result = await db.execute(
            sa_update(RefreshToken)
            .where(
                RefreshToken.user_id == user_id,
                RefreshToken.session_id == old_sid,
                RefreshToken.revoked_at.is_(None),
            )
            .values(session_id=new_sid)
        )
        return result.rowcount or 0

    ua = _short_ua(user_agent)
    rows = (
        await db.execute(
            select(RefreshToken).where(
                RefreshToken.user_id == user_id,
                RefreshToken.revoked_at.is_(None),
                RefreshToken.expires_at > at,
            )
        )
    ).scalars().all()
    moved = 0
    for rt in rows:
        if (rt.user_agent or None) != ua:
            continue
        if await _session_alive(db, as_sid(rt.session_id), at):
            continue
        rt.session_id = new_sid  # type: ignore[assignment]
        moved += 1
    return moved


__all__ = [
    "as_sid",
    "parse_sid",
    "relink_to_new_session",
    "revoke_session_of_token_fallback",
    "revoke_sessions",
    "revoke_sessions_of_tokens",
]
