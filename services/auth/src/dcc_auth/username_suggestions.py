"""Username-suggestion helper for the registration endpoint.

When the user picks a handle that's already taken, ``/register`` returns
a 409 body that includes 3 alternative suggestions. Reduces friction:
the user doesn't have to brainstorm + retry until something sticks.

Strategy: generate 6 candidates by appending random 2-3 digit suffixes
(with three separators: ``_``, ``.``, none), filter against the DB in
one round-trip, return the first 3 free ones. All candidates fit the
USERNAME_PATTERN ``^[a-zA-Z0-9_.-]{3,32}$`` because the base is trimmed
to 28 chars max (leaving 4 for the suffix).
"""

from __future__ import annotations

import secrets

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_auth.models import User

_MAX_BASE = 28  # 32 cap − 4 chars of suffix headroom


def _candidates(base: str) -> list[str]:
    """Generate 6 candidate usernames from ``base`` with random suffixes.

    Order matters: shorter / cleaner variants come first so the picked
    3 read naturally.
    """
    trimmed = base[:_MAX_BASE]
    n2 = [f"{secrets.randbelow(90) + 10}" for _ in range(3)]  # 10-99
    n3 = [f"{secrets.randbelow(900) + 100}" for _ in range(3)]  # 100-999
    return [
        f"{trimmed}_{n2[0]}",
        f"{trimmed}.{n2[1]}",
        f"{trimmed}{n2[2]}",
        f"{trimmed}_{n3[0]}",
        f"{trimmed}.{n3[1]}",
        f"{trimmed}{n3[2]}",
    ]


async def suggest_usernames(
    session: AsyncSession, base: str, *, want: int = 3
) -> list[str]:
    """Return up to ``want`` username suggestions that are currently free.

    Falls below ``want`` only in the (very unlikely) case all 6 candidates
    happened to collide — the user can retry their own input then.
    """
    pool = _candidates(base)
    taken = await session.scalars(
        select(User.username).where(User.username.in_(pool))
    )
    taken_set = set(taken.all())
    free = [c for c in pool if c not in taken_set]
    return free[:want]
