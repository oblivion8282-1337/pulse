"""Einladungs-Benachrichtigungen — die EINE Schiene fuer Community-Einladungen.

``community_invite_notifications`` fährt auf den Schienen der
Freundschaftsanfragen (User-Entscheidung 2026-07-13): der Empfänger sieht die
Einladung mit Annehmen/Ablehnen — keine DM, keine Karte im Chat.

**Seit 2026-08-27 ist das der einzige Weg.** Vorher lief die Einladung unter
Freunden über den ``community_invites``-Broker, der serverseitig eine
Nachricht in den DM-Kanal schrieb — mit ``author_id`` des Einladenden, also
im Namen eines Dritten. Das ist mit Ende-zu-Ende-verschlüsselten
Direktnachrichten strukturell unmöglich: der Server hat dafür keinen
Schlüssel und soll nie einen haben. Hintergrund + Gesamtplan:
``docs/superpowers/specs/2026-08-27-einladungen-ohne-dm-design.md``.

Damit trägt diese Tabelle jetzt BEIDE Zugangswege, deren Gates weiterhin
verschieden sind (Absicht, nicht Nachlässigkeit): Freunde dürfen auf
Self-Host-Ziele einladen (``target_host`` + host-geprägter ``code``),
Nicht-Freunde nur per Nutzername in Cloud-Communities.

Eine Zeile lebt nur, solange die Einladung offen ist: Annehmen und Ablehnen
**löschen** sie. Deshalb gibt es keine ``status``-Spalte — ihre Existenz IST
der Zustand. Ein Verlaufsregister über Einladungen wäre gespeicherte Sozial-
Information ohne Nutzen für den Betrieb.

Kein Unique-Constraint für „ein offener pro (guild, invitee)": SQLite
(Tests) kennt keine partiellen Indizes über unser Setup — der Guard läuft
als Query im POST (wie die Friend-Request-Dedupe-Prüfung).

Kein FK auf User (Identität lebt in auth-svc) — und seit 2026-08-27 auch
keiner mehr auf ``guilds``: ``guild_id`` kann auf eine Community auf einem
fremden Host zeigen, für die es in der Cloud keine Zeile gibt. Das Aufräumen
beim Community-Löschen macht deshalb die Delete-Route von Hand, wie es
``Message.channel_id`` aus demselben Grund schon tut.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Index, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base, snowflake_pk


class CommunityInviteNotification(Base):
    """Eine offene Community-Einladung. Entschieden = Zeile weg."""

    __tablename__ = "community_invite_notifications"

    id: Mapped[int] = snowflake_pk()
    guild_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    inviter_user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    invitee_user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # NULL = Cloud-Ziel. Sonst der Host, auf dem die Community lebt; die Cloud
    # prüft ihn nie, sie reicht ihn nur weiter (sie kann einen fremden
    # Einladungscode gar nicht verifizieren).
    target_host: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Rein informativ — hilft dem Klienten, den Servereintrag zuzuordnen.
    target_instance_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # Host-geprägter Einladungscode. Nur beim Weg unter Freunden gesetzt; beim
    # Nutzername-Weg legt die Cloud die Mitgliedschaft selbst an.
    code: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Denormalisiert: bei einem Self-Host-Ziel kennt die Cloud die guilds-Zeile
    # nicht, kann den Namen für die Karte also nirgends nachschlagen.
    guild_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # Spiegelt die Absicht der Host-Einladung, damit tote Karten wegfegbar sind.
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        # Inbox des Empfängers (ready-Frame + GET /me/community-invites). Ohne
        # status-Spalte reicht der Empfänger allein — jede vorhandene Zeile ist
        # eine offene Einladung.
        Index(
            "ix_community_invite_notifications_invitee",
            "invitee_user_id",
        ),
        Index("ix_community_invite_notifications_expires", "expires_at"),
        # Dedupe-Guard-Query im POST (guild+invitee).
        Index(
            "ix_community_invite_notifications_guild_invitee",
            "guild_id",
            "invitee_user_id",
        ),
    )
