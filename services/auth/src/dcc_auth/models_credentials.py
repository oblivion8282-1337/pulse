"""Reservierte Nutzernamen.

Dieses Modul hiess bis zum 2026-08-28 ``models_credentials`` und trug die
Gerätezertifikate (``issued_credentials``) samt ihren Grabsteinen
(``revoked_credentials``). Beide sind mit dem Zertifikatsmodell entfallen
(Migration 0051). Übrig ist die Namensreservierung, die nie etwas mit
Zertifikaten zu tun hatte und nur hier lag.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Index,
    LargeBinary,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects import sqlite as _sqlite
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from dcc_auth.db import Base


class UsernameReservation(Base):
    """30-day hold on a just-vacated username (Block 1.D, migration 0016).

    When a user changes username the old name is reserved for 30 days so
    only the original holder can reclaim it.  After ``released_at`` the
    name is free again; the cleanup sweep removes expired rows.
    """

    __tablename__ = "username_reservations"

    old_username: Mapped[str] = mapped_column(String(32), primary_key=True)
    original_user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    released_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        Index("ix_username_reservations_released_at", "released_at"),
    )
