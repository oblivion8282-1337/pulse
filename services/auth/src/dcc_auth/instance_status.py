"""Online-Zustand + Anzeigename einer Instanz an ihre Mitglieder melden.

Die Server-Leiste der Clients zeigt Heim-Server nur, solange sie laufen
(Entscheid 2026-10-08: gestoppt = für ALLE ausgeblendet, auch den Owner),
und unter ihrem Namen statt der Relay-Adresse. Beides weiß die Cloud:

* **online** — das Telefonbuch (``instance_direct_endpoints``): der
  direct-adapter des Servers meldet sich alle paar Minuten (Heartbeat), beim
  geordneten Stopp meldet er sich ab (``/offline``). Ein Absturz oder
  Stromausfall meldet sich NICHT ab — deshalb der Wächter unten, der einen
  Eintrag nach ``directory_online_threshold_seconds`` ohne Heartbeat als
  offline wertet.
* **anzeigename** — meldet der Server selbst (``POST /selfhost/anzeigename``).

Gemeldet wird nur ein WECHSEL (``online_gemeldet`` hält den zuletzt
gemeldeten Stand) — ein Heartbeat im Minutentakt soll nicht jedes Mal alle
Mitglieder wecken. Zugestellt wird über ``user:events`` je Mitglied; der
chat-gateway der Cloud reicht das an alle Sockets des Kontos weiter.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from dcc_auth.admin_events import USER_EVENTS_CHANNEL
from dcc_auth.config import Settings
from dcc_auth.models_instances import (
    InstanceDirectEndpoint,
    RegisteredInstance,
    UserInstanceMembership,
)

log = logging.getLogger(__name__)

#: Wie oft der Wächter nach verstummten Servern sucht. Klein gegen die
#: Online-Schwelle (300 s) — die Verzögerung „Absturz → ausgeblendet" ist
#: Schwelle + höchstens dieser Takt.
WAECHTER_TAKT_S = 30


def ereignis(inst: RegisteredInstance) -> dict:
    """Nutzlast des ``instance_status``-Ereignisses (ohne Empfänger)."""
    return {
        "op": "instance_status",
        "data": {
            "instance_id": str(inst.id),
            "online": inst.online_gemeldet,
            "anzeigename": inst.anzeigename,
        },
    }


async def melde(redis, db: AsyncSession, inst: RegisteredInstance) -> None:
    """Den aktuellen Stand an jedes Mitglied der Instanz schicken (best effort)."""
    if redis is None:
        return
    mitglieder = (
        await db.execute(
            select(UserInstanceMembership.user_id).where(
                UserInstanceMembership.instance_id == inst.id
            )
        )
    ).scalars().all()
    nutzlast = ereignis(inst)
    for uid in mitglieder:
        try:
            await redis.publish(
                USER_EVENTS_CHANNEL, json.dumps({**nutzlast, "_target_user_id": str(uid)})
            )
        except Exception:  # noqa: BLE001
            log.warning("instance_status an %s nicht zugestellt", uid, exc_info=True)


async def setze_online(redis, db: AsyncSession, inst: RegisteredInstance, online: bool) -> None:
    """Online-Zustand setzen; nur bei einem Wechsel speichern und melden."""
    if inst.online_gemeldet == online:
        return
    inst.online_gemeldet = online
    await db.commit()
    await melde(redis, db, inst)


async def verstummte(db: AsyncSession, schwelle_s: int, jetzt: datetime) -> list[RegisteredInstance]:
    """Als online gemeldete Instanzen, deren letzter Heartbeat älter als die
    Schwelle ist — oder die gar keinen Telefonbuch-Eintrag mehr haben."""
    grenze = jetzt - timedelta(seconds=schwelle_s)
    stmt = (
        select(RegisteredInstance)
        .outerjoin(
            InstanceDirectEndpoint,
            InstanceDirectEndpoint.instance_id == RegisteredInstance.id,
        )
        .where(RegisteredInstance.online_gemeldet.is_(True))
        .where(
            (InstanceDirectEndpoint.instance_id.is_(None))
            | (InstanceDirectEndpoint.updated_at < grenze)
        )
    )
    return list((await db.execute(stmt)).scalars().all())


async def waechter_einmal(redis, sitzungen: async_sessionmaker, schwelle_s: int) -> int:
    async with sitzungen() as db:
        treffer = await verstummte(db, schwelle_s, datetime.now(UTC))
        for inst in treffer:
            await setze_online(redis, db, inst, False)
        return len(treffer)


async def waechter_loop(app, settings: Settings, engine: AsyncEngine) -> None:
    """Läuft bis zum Abbruch; wertet verstummte Server als offline.

    ``app`` statt eines Redis-Clients: der wird im Lifespan erst nach dem
    Start dieses Tasks verbunden (und kann ``None`` sein)."""
    sitzungen = async_sessionmaker(engine, expire_on_commit=False)
    schwelle = settings.directory_online_threshold_seconds
    while True:
        try:
            n = await waechter_einmal(getattr(app.state, "redis", None), sitzungen, schwelle)
            if n:
                log.warning("instance_status_waechter: %d Server ohne Heartbeat → offline", n)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("instance_status_waechter_fehler")
        await asyncio.sleep(WAECHTER_TAKT_S)
