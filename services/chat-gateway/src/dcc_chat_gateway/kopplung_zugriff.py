"""Wer darf an einer laufenden Kopplung mitspielen (Etappe F, E2E-DM).

Eine Stelle, weil sonst jede der sieben Routen ihre eigene Fassung derselben
drei Bedingungen truege — und die vergessene vierte faellt nicht auf.

**Die drei Bedingungen, alle fail-closed:**

1. Die Kopplung gehoert dem angemeldeten Konto (``user_id``).
2. Sie ist nicht verfallen.
3. Das nachgewiesene Geraet hat in ihr die verlangte ROLLE — ``alt`` (zeigt
   den Code, schiebt) oder ``neu`` (loest ein, holt).

Punkt 3 ist der, den man beim Nachbauen vergisst: ohne ihn duerfte jedes
Geraet des Kontos die Stuecke abholen, und die Kopplung waere kein Kanal
zwischen ZWEI Geraeten mehr, sondern ein kontoweiter Ablagekorb. Der
Chiffretext bliebe zwar zu, aber ein spaeter kompromittiertes Drittgeraet
koennte ihn wegschnappen und aufheben, bis es den Code hat.

**Warum 404 und nicht 403:** ein fremdes oder verfallenes ``kopplung_id``
liefert dieselbe Antwort wie ein nie existierendes. Wer raet, erfaehrt so
nicht, welche IDs es gibt.
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models import Kopplung


def _als_utc(wert: datetime) -> datetime:
    """SQLite gibt ``DateTime(timezone=True)`` naiv zurueck, Postgres nicht.

    Ohne diese Anpassung wirft der Vergleich mit ``datetime.now(UTC)`` im
    Test ``TypeError`` und im Betrieb nicht — der Unterschied faellt dann
    erst auf der Prod-Datenbank auf, also am spaetestmoeglichen Ort.
    """
    return wert if wert.tzinfo is not None else wert.replace(tzinfo=UTC)


async def kopplung_laden(
    session: AsyncSession,
    kopplung_id: int,
    user_id: int,
    device_pubkey: str,
    rolle: str,
) -> Kopplung:
    """Laedt die Kopplung, wenn Konto, Frist und Rolle stimmen — sonst 404.

    ``rolle`` ist ``"alt"`` oder ``"neu"``. Bei ``"neu"`` ist eine noch nicht
    eingeloeste Kopplung automatisch ausgeschlossen: ``neu_device_pubkey`` ist
    dann ``None`` und kann keinem Pubkey gleichen.
    """
    kopplung = (
        await session.execute(
            select(Kopplung).where(Kopplung.id == kopplung_id, Kopplung.user_id == user_id)
        )
    ).scalar_one_or_none()
    if kopplung is None:
        raise HTTPException(status_code=404, detail="kopplung_unbekannt")

    if _als_utc(kopplung.verfaellt_am) <= datetime.now(UTC):
        raise HTTPException(status_code=404, detail="kopplung_unbekannt")

    erwartet = kopplung.alt_device_pubkey if rolle == "alt" else kopplung.neu_device_pubkey
    if erwartet is None or erwartet != device_pubkey:
        raise HTTPException(status_code=404, detail="kopplung_unbekannt")

    return kopplung
