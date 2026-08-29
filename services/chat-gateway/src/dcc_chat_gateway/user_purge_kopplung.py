"""Konto-Purge: Geraete-Kopplung + Verlaufsumzug (Etappe F, E2E-DM).

Abgetrennt aus demselben Grund wie ``user_purge_postfach.py``: die Datei
laeuft sonst ueber die Groessen-Policy (PLAN.md §12.1).

**Bughunt-Runde 6, Befund 5:** ``Kopplung``/``UmzugStueck`` ueberlebten einen
Konto-Purge bisher unveraendert — dieselbe Faehrte wie beim Postfach vor
Etappe D (s. Docstring von ``user_purge_postfach.py``) und bei
``community_invite_notifications`` nach Migration 0063 (s.
``user_purge_gruppen.py``). ``routes/internal.py::purge_user`` erwaehnte
weder ``Kopplung`` noch ``UmzugStueck``, und es gab keinen Test dafuer
(anders als fuer das Postfach: ``test_purge_raeumt_e2e_postfach``).

**Ausdruecklich geloescht, nicht ueber CASCADE** — dieselbe Begruendung wie
in ``kopplung_pflege.py``: der ``ondelete="CASCADE"`` am Modell greift auf
Postgres, aber SQLite erzwingt Fremdschluessel im Testaufbau nicht, ein
Aufraeumen allein per CASCADE waere dort nicht beobachtbar.

Beide Rollen einer Kopplung — das ANZEIGENDE (``alt_device_pubkey``) und das
EINLOESENDE Geraet (``neu_device_pubkey``) — gehoeren demselben Konto
(``Kopplung.user_id``, s. Modell-Docstring: eine Kopplung ist eine
Verabredung zwischen zwei Geraeten DESSELBEN Kontos). Ein einziges
``user_id``-Filter auf ``Kopplung`` reicht deshalb aus; ``UmzugStueck`` haengt
nur ueber ``kopplung_id`` und wird darueber mitgenommen.

Kein Commit hier — laeuft innerhalb derselben Transaktion wie der Rest von
``user_purge.py::_purge_db``.
"""

from __future__ import annotations

from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models import Kopplung, UmzugStueck


async def purge_kopplung(session: AsyncSession, user_id: int) -> None:
    """Raeumt jede Kopplung des Kontos samt ihren Umzugs-Stuecken."""
    kopplung_ids = list(
        (
            await session.execute(
                select(Kopplung.id).where(Kopplung.user_id == user_id)
            )
        ).scalars()
    )
    if not kopplung_ids:
        return
    await session.execute(
        sa_delete(UmzugStueck).where(UmzugStueck.kopplung_id.in_(kopplung_ids))
    )
    await session.execute(sa_delete(Kopplung).where(Kopplung.id.in_(kopplung_ids)))


__all__ = ["purge_kopplung"]
