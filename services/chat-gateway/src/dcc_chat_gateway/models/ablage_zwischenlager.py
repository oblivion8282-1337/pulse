"""Das Zwischenlager der Community-Dateiablage (Etappe E8, Design §7).

Ein Mitglied verschluesselt lokal (Kernaufteilung §1) und legt das Chiffrat
hier ab; ein Geraet des Community-Besitzers holt es, schreibt es ins
eigentliche Laufwerk (``routes/ablage_zwischenlager.py``,
``festigung.ts``) und quittiert — erst DANACH loescht der Server die Zeile
UND den Klumpen im Objektspeicher. Bis dahin ist die Datei ueber diese
Tabelle sofort les-/herunterladbar (,,noch nicht gesichert").

**Der Server kennt weder Dateiname noch MIME-Typ.** Beide stecken
verschluesselt im PADF-Kopf des Klumpens (``ablage/dateiablage.ts``); diese
Zeile traegt nur, was fuer Kontingent, Alter und Zustellung noetig ist.

``hochgeladen_von`` ist das MITGLIED, das den Klumpen eingeliefert hat — nicht
der Besitzer. Kein Fremdschluessel auf einen Nutzer (derselbe Grund wie bei
``DmZustellung.empfaenger_user_id``: das Konto kann geloescht werden, die
Zeile bleibt trotzdem gueltig, bis sie regulaer geraeumt wird).
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base


class AblageZwischenlagerDatei(Base):
    __tablename__ = "ablage_zwischenlager_dateien"

    # Snowflake, serververgeben (dcc_chat_gateway.snowflake.next_id) — wie
    # jede andere ID auf der Leitung als String kodiert.
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    guild_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("guilds.id", ondelete="CASCADE"), nullable=False
    )
    hochgeladen_von: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # Bytes des Klumpens im Objektspeicher — fuer die Kontingent-Rechnung
    # (``ablage_zwischenlager_max_gesamt_bytes``) ohne einen HEAD-Aufruf je
    # Zeile.
    groesse: Mapped[int] = mapped_column(BigInteger, nullable=False)
    storage_key: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        # Haeufigste Abfragen: Kontingent-Summe je Community, Liste fuer die
        # Ansicht, Alters-Sweep — alle beginnen mit ``guild_id``.
        Index("ix_ablage_zwischenlager_guild", "guild_id", "id"),
    )
