"""Einladungs-Benachrichtigungen an Nicht-Freunde (Cloud-only, v1).

``community_invite_notifications`` fährt auf den Schienen der
Freundschaftsanfragen (User-Entscheidung 2026-07-13): DMs bleiben strikt
friends-only, aber ein Community-Mitglied mit CREATE_INVITES darf einen
beliebigen Cloud-User **per Nutzername** einladen. Der Empfänger sieht die
Einladung wie eine Freundschaftsanfrage (Annehmen/Ablehnen) — keine DM,
keine Karte im Chat.

Abgrenzung zum bestehenden ``community_invites``-Broker: der relayed
Friend-zu-Friend-Einladungen als DM-Karte (inkl. Self-Host-Ziele über den
host-coined Code). DIESE Tabelle ist NUR für Cloud-Communities — eine
Nutzername-Einladung auf einen Self-Host wäre cross-server (der Empfänger
müsste erst Instanz-Mitglied werden) und ist bewusst nicht Teil von v1.

Kein Unique-Constraint für „ein pending pro (guild, invitee)": SQLite
(Tests) kennt keine partiellen Indizes über unser Setup — der Guard läuft
als Query im POST (wie die Friend-Request-Dedupe-Prüfung); entschiedene
Zeilen (accepted/declined) bleiben als Historie und dürfen koexistieren.

Kein FK auf User (Identität lebt in auth-svc); FK auf guilds CASCADE, damit
eine gelöschte Community ihre offenen Einladungen mitnimmt.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base, snowflake_pk


class CommunityInviteNotification(Base):
    """Nutzername-Einladung in eine Cloud-Community, pending bis entschieden."""

    __tablename__ = "community_invite_notifications"

    id: Mapped[int] = snowflake_pk()
    guild_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("guilds.id", ondelete="CASCADE"),
        nullable=False,
    )
    inviter_user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    invitee_user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # pending | accepted | declined
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        # Pending-Inbox des Empfängers (ready-Frame + GET /me/community-invites).
        Index(
            "ix_community_invite_notifications_invitee_status",
            "invitee_user_id",
            "status",
        ),
        # Dedupe-Guard-Query im POST (guild+invitee, status='pending').
        Index(
            "ix_community_invite_notifications_guild_invitee",
            "guild_id",
            "invitee_user_id",
        ),
    )
