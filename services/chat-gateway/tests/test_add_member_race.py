"""Regression: concurrent first-time join must not crash (membership.py).

``add_member`` does a non-atomic check-then-insert: two concurrent first-time
cert-logins for the same identifier both pass ``is_member()`` (no committed row
yet) and race to INSERT. The loser used to hit the primary-key constraint and
propagate an unhandled ``IntegrityError`` → HTTP 500. The fix wraps the INSERT
in a SAVEPOINT and swallows the collision as a no-op (first provenance wins).

We simulate the race deterministically: a row is already committed for the
identifier, but ``is_member`` is forced to report ``False`` so the INSERT path
runs into the existing row — exactly what the losing concurrent request sees.
"""

from __future__ import annotations

import pytest
from dcc_chat_gateway import membership
from dcc_chat_gateway.models import InstanceMember
from sqlalchemy import func, select


@pytest.mark.asyncio
async def test_add_member_loses_race_is_noop(session_factory, monkeypatch):
    ident = "pairwise-sub-abc123"

    # A concurrent request already committed the membership row.
    async with session_factory() as setup:
        setup.add(InstanceMember(user_identifier=ident, joined_via="public"))
        await setup.commit()

    # Force the stale-read the losing request saw (row not yet visible) so the
    # INSERT path runs and collides on the primary key.
    async def _no(_session, _ident):
        return False

    monkeypatch.setattr(membership, "is_member", _no)

    async with session_factory() as session:
        # Must NOT raise — the collision is swallowed as a no-op.
        await membership.add_member(session, ident, joined_via="invite")
        await session.commit()

    # Exactly one row, first provenance ("public") preserved.
    async with session_factory() as check:
        count = (
            await check.execute(
                select(func.count()).select_from(InstanceMember).where(
                    InstanceMember.user_identifier == ident
                )
            )
        ).scalar_one()
        assert count == 1
        row = await check.get(InstanceMember, ident)
        assert row.joined_via == "public"
