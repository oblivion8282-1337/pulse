"""User-scoped preference blobs (Plugin-System Schritt 3b).

Each row is one named "section" of preferences for one user; the value
is opaque JSON. Plugins (and built-in settings sections) that opt into
cross-device sync (``persistence: 'server'`` on the frontend
``SectionConfig``) get a server-side mirror here; everything else
remains ``localStorage``-only and never touches this table.

Schema note: chat-gateway DB (``chat`` schema), not auth-svc. Plugin
state is part of the chat-product domain; auth-svc deliberately owns
only identity + credentials (per PLAN.md's "services don't share DB
tables" rule, the choice between auth and chat is a permanent
ownership call). No FK to ``auth.users`` for the same reason — user
purge clears these rows via the existing internal HTTP pathway.

Composite PK ``(user_id, section_name)`` keeps the per-section upsert
a single ``ON CONFLICT``. ``version`` is bumped on each write and lets
the route layer support optimistic concurrency (``If-Match`` header,
optional).
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    DateTime,
    Index,
    Integer,
    PrimaryKeyConstraint,
    String,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base


class UserPreference(Base):
    """One named preference section's value for one user.

    ``section_name`` is the same identifier a plugin passes to
    ``registerSettingsSection(name, …)`` on the frontend (e.g.
    ``"tamagotchi"`` or ``"appearance"``). Constrained to 64 chars to
    match the conservative plugin-name pattern (``^[a-z][a-z0-9_-]{1,31}$``,
    plus headroom for namespacing later).

    ``value`` is opaque JSON. The route layer accepts any
    serialisable object/array/primitive — validation is the plugin's
    job on the consuming side (mirroring the frontend's section
    ``parse`` hook).

    ``version`` starts at 1 on first insert and is incremented on every
    update. The PUT route accepts an optional ``If-Match: <version>``
    header for optimistic concurrency; mismatched → 412.
    """

    __tablename__ = "user_preferences"

    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    section_name: Mapped[str] = mapped_column(String(64), nullable=False)
    value: Mapped[dict] = mapped_column(JSON, nullable=False)
    version: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("1"), default=1
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    __table_args__ = (
        PrimaryKeyConstraint(
            "user_id", "section_name", name="pk_user_preferences"
        ),
        # Secondary index for the "all sections for one user" fetch on
        # login — the PK already covers (user_id, section_name) so
        # range scans on user_id alone are fine without a dedicated
        # index, but we add a covering one to keep the JSON read off
        # the table heap in busy workloads. (Cheap, single-column.)
        Index("ix_user_preferences_user", "user_id"),
    )


__all__ = ["UserPreference"]
