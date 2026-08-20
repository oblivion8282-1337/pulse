"""Tests für die Freigabeliste eines Standplatz-Geräts.

Die Liste sagt, WER einen Rechner ohne Rückfrage übernehmen darf. Sie lag bis
2026-08-20 auf dem Gerät selbst und war damit nur vor Ort änderbar; Entwurf:
``docs/superpowers/specs/2026-08-20-geraeteverwaltung-design.md``.
"""

from __future__ import annotations

import pytest
from dcc_chat_gateway.models import SUBJECT_EVERYONE, SUBJECT_USER, DeviceGrant


@pytest.mark.asyncio
async def test_freigabe_haengt_am_geraet(session_factory):
    async with session_factory() as session:
        session.add(
            DeviceGrant(
                id=1,
                device_id=42,
                subject_type=SUBJECT_EVERYONE,
                subject_id=None,
                expires_at=None,
                created_by_user_id=7,
            )
        )
        await session.commit()
        geladen = await session.get(DeviceGrant, 1)
        assert geladen.subject_type == SUBJECT_EVERYONE
        assert geladen.subject_id is None
        assert geladen.created_at is not None
