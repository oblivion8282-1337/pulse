"""Call-Entität für DM- und Gruppenanrufe (Übergabe P0, Anrufe-Epic A).

Ein Anruf hängt an einem DM-Kanal oder einer privaten Gruppe —
``channel_id`` ist polymorph (wie ``Message.channel_id``), deshalb ohne
FK. Der LiveKit-Raum heißt deterministisch ``call-{id}`` (aufgestellt in
voice-signaling ``routes/call_token.py``); die Membership prüfen die
Routen hier gegen die DM-/Gruppen-Teilnehmer, nicht gegen Guild-Kanäle.

Zustandsmaschine (bewusst klein): klingelnd → laufend (erstes Annehmen)
→ beendet. ``grund`` sagt dem Klienten, was als Systemzeile landet:
aufgelegt / abgelehnt / verpasst.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Index, SmallInteger, func
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base, snowflake_pk

ART_DM = 0
ART_GRUPPE = 1

ZUSTAND_KLINGELND = 0
ZUSTAND_LAEUFEND = 1
ZUSTAND_BEENDET = 2

GRUND_AUFGELEGT = 0
GRUND_ABGELEHNT = 1
GRUND_VERPASST = 2


class Anruf(Base):
    __tablename__ = "anrufe"

    id: Mapped[int] = snowflake_pk()
    art: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    channel_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    einleiter_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    zustand: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    grund: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    verbunden_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    beendet_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    erstellt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (Index("ix_anrufe_channel_erstellt", "channel_id", "erstellt_at"),)

    def raum(self) -> str:
        """Der LiveKit-Raum dieses Anrufs — Schema in voice-signaling
        ``call_token.py`` gespiegelt; der Client baut den Namen nie selbst."""
        return f"call-{self.id}"
