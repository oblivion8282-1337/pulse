"""Die eine Drahtform einer Rolle.

Eigenes Modul, weil drei Stellen dieselbe Form brauchen: die Rollen-CRUD
(``routes/roles.py``, ``guild:events``-Broadcasts), der ``ready``-Frame
(``routes/ws_ready.py``) und darüber der Frontend-Typ ``Role``. Der
Ready-Frame baute sie bis 2026-08-16 von Hand nach und verlor dabei
``guild_id`` — der Frontend-Typ führt das Feld als Pflicht, also lief dort
jede Rollen-Zuordnung ins Leere. Eine Stelle statt zwei, die auseinanderlaufen.
"""

from __future__ import annotations

from dcc_chat_gateway.models import Role


def role_wire_dict(role: Role) -> dict[str, object]:
    """Wire shape mirroring ``RoleOut``.

    IDs und Bitfelder als Strings — JS ``Number`` trägt 64 Bit nicht exakt
    (dieselbe Begründung wie bei den Snowflakes).
    """
    return {
        "id": str(role.id),
        "guild_id": str(role.guild_id),
        "name": role.name,
        "permissions": str(role.permissions),
        "color": role.color,
        "position": role.position,
        "hoist": role.hoist,
        "mentionable": role.mentionable,
        "is_everyone": role.is_everyone,
    }
