"""Voice-Pull: temporäre Sichtbarkeits-Grants für private Voice-Channels.

Ein „Voice-Pull" (Verwalter zieht einen anderen User in einen privaten
Voice-Channel) legt zusätzlich zum User-Overwrite (VIEW_CHANNEL|CONNECT)
eine Zeile hier an. Diese Tabelle ist die Quelle der Wahrheit, *welche*
Overwrite-Grants temporär sind und beim Verlassen des Channels wieder
entzogen werden — ein permanenter Admin-Grant (derselbe User-Overwrite)
darf vom Auto-Revoke nicht angetastet werden (siehe routes/internal.py).

Der PK (channel_id, user_id) macht Re-Pulls zu einem Upsert.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, PrimaryKeyConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base


class ChannelVoicePull(Base):
    """Marker row: dieser User wurde per Voice-Pull in diesen Channel gezogen.

    Existenz ⇒ der zugehörige ``VIEW_CHANNEL|CONNECT``-User-Overwrite ist
    temporär und wird beim Verlassen (LiveKit-Disconnect) wieder entzogen.
    """

    __tablename__ = "channel_voice_pulls"

    channel_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("channels.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    granted_by: Mapped[int] = mapped_column(BigInteger, nullable=False)
    granted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (PrimaryKeyConstraint("channel_id", "user_id"),)
