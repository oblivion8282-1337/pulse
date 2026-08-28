"""Private Gruppenkanäle (Etappe G1, die Kanal-Hälfte).

Eine dritte Kanalart neben Community-Kanal (``Channel``) und DM
(``DirectMessageChannel``, s. dessen Docstring in ``models/channels.py``):
``Message.channel_id`` zeigt heute schon polymorph auf zwei Tabellen, die
dritte reiht sich ein — deshalb die Snowflake-ID aus demselben Generator
(``snowflake_pk()``), nicht aus einem eigenen Zaehler.

**Ohne Krypto und ohne Rechte-System.** Wer anlegt (``ersteller_id``), darf
Mitglieder hinzufuegen und entfernen; jedes Mitglied darf selbst gehen. Keine
Rollen, keine Overwrites — das ist der Unterschied zu einer Community und
Absicht (Spec §9). Die drei Festlegungen, die die Spec ausdruecklich verlangt
(Ersteller geht / letztes Mitglied geht / Blockierung sperrt das Hinzufuegen),
stehen mit Begruendung in ``routes/private_gruppen.py`` — hier nur die Form
der Daten.

**Der Schalter ist an anderer Stelle** (``config.py::private_groups_enabled``,
Vorgabe aus): diese Etappe baut die Kanalart, schaltet sie aber nicht frei.
Solange der Schalter aus ist, entsteht keine Zeile in diesen Tabellen.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base, snowflake_pk


class PrivateGroupChannel(Base):
    __tablename__ = "private_group_channels"

    id: Mapped[int] = snowflake_pk()
    ersteller_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # Bumped bei jeder neuen Nachricht — dasselbe Feld, derselbe Zweck wie
    # ``DirectMessageChannel.last_message_id`` (Sortierung nach Aktualitaet).
    # Erst mit Task 3 tatsaechlich gepflegt.
    last_message_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)


class PrivateGroupMember(Base):
    """Eine Mitgliedschaftszeile. ``ON DELETE CASCADE`` auf die Gruppe: eine
    aufgeloeste Gruppe darf keine verwaisten Mitgliedszeilen hinterlassen —
    dieselbe Pruefung wie beim Geraete-Schluesselverzeichnis
    (``models/geraete_schluessel.py``, ``test_schluessel.py``). SQLite
    erzwingt das nur mit ``PRAGMA foreign_keys=ON`` je Verbindung (autouse-
    Fixture in den Tests)."""

    __tablename__ = "private_group_members"

    id: Mapped[int] = snowflake_pk()
    gruppe_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("private_group_channels.id", ondelete="CASCADE"),
        nullable=False,
    )
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    beigetreten_am: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        # Dieselbe Person darf nicht zweimal Mitglied sein — sonst zaehlt die
        # Gruppe falsch, und beim Verteilen des Gruppenschluessels (G2)
        # bekaeme dasselbe Konto zwei Umschlaege.
        UniqueConstraint("gruppe_id", "user_id", name="uq_private_group_members_mitglied"),
        Index("ix_private_group_members_gruppe", "gruppe_id"),
        Index("ix_private_group_members_user", "user_id"),
    )
