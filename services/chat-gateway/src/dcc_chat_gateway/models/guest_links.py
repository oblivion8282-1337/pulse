"""``chat.guest_links`` — Besprechungslinks für Leute ohne Pulse-Konto.

Ein Mitglied mit ``MOVE_MEMBERS`` erzeugt für einen Sprachkanal einen Link mit
Ablauf. Wer ihn öffnet, tippt einen Namen ein und sitzt im Kanal — ohne Konto,
ohne Mitgliedschaft, ohne Rolle.

**Der Code steht nie in der Datenbank**, nur sein SHA-256. Wer die Tabelle
liest (Sicherung, Fehlersuche, ein zu weit gefasster Admin-Blick), kommt damit
nicht in eine laufende Besprechung. Dasselbe Muster wie ``_token_redis_key``
in ``session_tokens.py``. Folge, die man kennen muss: der Code ist nach dem
Erzeugen nicht mehr rekonstruierbar — die Liste zeigt ihn nicht, wer ihn
verliert, erzeugt einen neuen.

**Warum ``MOVE_MEMBERS`` und nicht ``CREATE_INVITES``:** eine gewöhnliche
Einladung führt jemanden durch die Mitgliedschaft und damit durch das ganze
Rechtesystem; ein Gast-Link führt daran vorbei. Wer einladen darf, dürfte
sonst unbeabsichtigt mehr. ``MOVE_MEMBERS`` trägt bereits den Rauswurf aus dem
Sprachkanal — hereinbitten und hinauswerfen gehören zusammen.

**Wer gerade drin sitzt, steht NICHT hier, sondern in Redis** (``gast:*``).
Dieselbe Überlegung wie bei den Standplatz-Geräten: eine Spalte löge nach
jedem Absturz, und zwar Richtung „ist noch da".

Kein FK auf ``guilds``/``channels`` (wie ``community_invite_notifications``,
aus demselben Grund: die Delete-Routen räumen von Hand, dafür bleibt das
Löschen einer Community frei von Reihenfolge-Zwängen).
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Index, String, func
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base, snowflake_pk


class GuestLink(Base):
    """Ein Besprechungslink für einen Sprachkanal."""

    __tablename__ = "guest_links"

    id: Mapped[int] = snowflake_pk()
    guild_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    channel_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # SHA-256 des Codes, hex. Unique: zwei Links mit demselben Code gäbe es
    # nur bei einer Zufallskollision über 128 bit — der Index ist die Prüfung.
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    created_by: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    # Frühester Eintritt. NULL = ab sofort gültig (der historische Modus — alle
    # Bestandslinks haben NULL und verhalten sich unverändert). Ein Link mit
    # Zukunfts-Start antwortet auf Beitritt/Info wie ein unbekannter Code (404),
    # damit die Existenz des Links nicht vorab verraten wird.
    valid_from: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Gesetzt = entwertet. Bewusst eine Spalte statt eines Löschens: die Liste
    # soll einen widerrufenen Link noch zeigen können, solange er nicht
    # abgelaufen ist ("den habe ich abgeschaltet" ist eine Antwort, ein
    # verschwundener Eintrag ist keine).
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        # Die Liste im Kanal-/Community-Menü.
        Index("ix_guest_links_guild", "guild_id"),
        Index("ix_guest_links_channel", "channel_id"),
    )
