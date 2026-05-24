"""Plugin-Aktivierungs-Modelle (Allowlist + Guild-Toggle).

Implementiert das Zwei-Ebenen-Aktivierungsmodell aus Migration
``0020_plugin_admin_activation``:

* :class:`InstancePluginAllowlist` — vom Bootstrap-Admin gepflegt. Eine
  Row pro Plugin, das auf dieser Instanz überhaupt geladen werden darf.
  Plugins, die per Discovery gefunden, aber NICHT in der Allowlist sind,
  registrieren ihre WS-Ops/Channels/Settings-Sections beim Startup
  **nicht** (Loader-Refactor).

* :class:`GuildPlugin` — vom Guild-Admin (``MANAGE_GUILD``) pro Server
  pro Plugin. Plugin muss in der Allowlist stehen, sonst lehnt die API
  ab. ``hello`` ist ein Sonderfall: gilt instanzweit als aktiv (kein
  Row in dieser Tabelle nötig, das Frontend zeigt es nicht als
  togglebar an).

Kein FK auf ``auth.users`` (cross-service Grenze — auth & chat haben
getrennte Schemas). ``plugin_name`` ist TEXT, kein Enum, weil Plugins
zur Compile-Zeit nicht bekannt sind.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    PrimaryKeyConstraint,
    Text,
    func,
    text,
)
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base


class InstancePluginAllowlist(Base):
    """Vom Bootstrap-Admin gepflegte Allowlist erlaubter Plugins.

    Eine Row pro Plugin-Name. Existenz = "darf auf dieser Instanz
    geladen werden". Fehlen = "vom Loader stillschweigend übersprungen
    (aber per Admin-API für die Aktivierung sichtbar)".
    """

    __tablename__ = "instance_plugin_allowlist"

    plugin_name: Mapped[str] = mapped_column(Text, nullable=False)
    added_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # Nullable: Bootstrap-Seed (``hello``) hat keinen Akteur, und
    # auch ein Self-Heal-Insert des Loaders setzt das Feld auf NULL.
    added_by_user_id: Mapped[int | None] = mapped_column(
        BigInteger, nullable=True
    )

    __table_args__ = (
        PrimaryKeyConstraint(
            "plugin_name", name="pk_instance_plugin_allowlist"
        ),
    )


class GuildPlugin(Base):
    """Pro-Guild-Toggle eines bereits erlaubten Plugins.

    Existenz der Row + ``enabled=true`` ⇒ Plugin ist auf dieser Guild
    aktiv. Existenz + ``enabled=false`` ⇒ explizit deaktiviert (vom
    Default-Off-Verhalten unterscheidbar). Keine Row ⇒ Default (aktuell
    `false` — Guild-Admins müssen jedes Plugin explizit einschalten).

    ``hello`` wird nicht in dieser Tabelle geführt; das Plugin gilt
    instanzweit als aktiv und Guild-Admins können es nicht togglen
    (`409` von der Guild-API).
    """

    __tablename__ = "guild_plugins"

    guild_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("guilds.id", ondelete="CASCADE"),
        nullable=False,
    )
    plugin_name: Mapped[str] = mapped_column(Text, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    enabled_by_user_id: Mapped[int | None] = mapped_column(
        BigInteger, nullable=True
    )
    enabled_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        PrimaryKeyConstraint("guild_id", "plugin_name", name="pk_guild_plugins"),
        Index("ix_guild_plugins_plugin", "plugin_name"),
    )


class GuildPluginState(Base):
    """Generic per-guild plugin state blob (Plugin-System PR3 "shared state").

    Eine Row pro ``(guild_id, plugin_name)``: das Plugin entscheidet
    selbst, welche Form ``state`` hat — JSONB unter Postgres, generisches
    JSON in Tests (siehe Migration 0021). Erster Konsument ist
    ``tamagotchi`` (ein Pet pro Guild, alle Member füttern es gemeinsam);
    weitere Plugins können dieselbe Tabelle wiederverwenden.

    Atomic-Updates laufen unter Postgres bevorzugt über
    ``jsonb_set(...) RETURNING state`` (siehe
    ``plugins/handlers/tamagotchi.py``); SQLite (Tests) fällt auf
    Read-Modify-Write mit row-lock zurück. Beide Pfade liegen
    plugin-spezifisch im Handler, nicht hier — das Model ist
    state-agnostisch.

    Cross-Service-Grenze: kein FK auf ``auth.users`` (``updated_by_user_id``
    bleibt nullable für System-Inserts).
    """

    __tablename__ = "guild_plugin_state"

    guild_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("guilds.id", ondelete="CASCADE"),
        nullable=False,
    )
    plugin_name: Mapped[str] = mapped_column(Text, nullable=False)
    # JSONB unter Postgres, JSON-Fallback unter SQLite. ``dict``-Type
    # für SQLAlchemy reicht; konkrete Pydantic-Validation passiert im
    # Handler. ``default=dict`` damit ein .add() ohne ``state``-Argument
    # keinen NULL setzt — die Migration hat einen ``'{}'``-server_default,
    # aber expliziter Python-Default ist robuster.
    state: Mapped[dict] = mapped_column(
        JSON().with_variant(postgresql.JSONB(), "postgresql"),
        nullable=False,
        default=dict,
        server_default=text("'{}'"),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
    updated_by_user_id: Mapped[int | None] = mapped_column(
        BigInteger, nullable=True
    )

    __table_args__ = (
        PrimaryKeyConstraint(
            "guild_id", "plugin_name", name="pk_guild_plugin_state"
        ),
        Index("ix_guild_plugin_state_plugin", "plugin_name"),
    )


__all__ = ["GuildPlugin", "GuildPluginState", "InstancePluginAllowlist"]
