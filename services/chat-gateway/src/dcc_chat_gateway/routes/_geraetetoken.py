"""Gemeinsamer Upsert für Gerätetoken-Tabellen (FCM und VoIP).

**Warum geteilt und nicht kopiert.** Beide Tabellen haben dieselbe Form
(``user_id`` + ``geraet_id`` als Schlüssel, ``token`` zusätzlich UNIQUE) und
damit dieselben zwei Rennen:

1. **Zwei Start-Aufrufe desselben Geräts.** Beide sehen keine Zeile, beide
   legen an, einer verliert mit ``IntegrityError``. Der Verlierer darf nicht
   still 204 liefern — dann käme sein frischer Token nie an (Befund
   03.10.2026, deshalb der zweite Durchgang unten).
2. **Ein Gerät wandert zu einem anderen Konto.** Der Token ist UNIQUE und
   gehört physisch zu genau einem Konto; die Zeile des alten Kontos wird
   vorher entfernt, sonst scheitert der Upsert an der Eindeutigkeit.

Diese Rechnung einmal zu haben ist der ganze Zweck: eine Kopie für den
VoIP-Token hätte beim nächsten Fund genau eine der beiden Stellen geheilt.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

# ``modell`` ist nur ``type[Any]``, und das ist kein Versehen: die geforderte
# Form (``user_id``, ``geraet_id``, ``token`` und ein Keyword-Konstruktor über
# alle drei) steht im Modulkopf. Ein ``Protocol`` dafür wäre hier eine
# Zusicherung ohne Prüfung — der Dienst fährt nur Ruff, keinen Typprüfer, und
# der Keyword-Konstruktor eines SQLAlchemy-Modells lässt sich im Protocol
# ohnehin nicht ausdrücken.


async def _zeile_des_geraets(
    session: Any, modell: type[Any], user_id: int, geraet_id: str
) -> Any | None:
    treffer = await session.execute(
        select(modell).where(modell.user_id == user_id, modell.geraet_id == geraet_id)
    )
    return treffer.scalar_one_or_none()


async def upsert(
    *,
    session: Any,
    modell: type[Any],
    user_id: int,
    geraet_id: str,
    token: str,
    konflikt_detail: str,
) -> None:
    """Token dieses Geräts speichern oder auffrischen.

    ``konflikt_detail`` ist der ``detail``-Text eines 409 — er bleibt je
    Tabelle eigen, damit ein Klient am Fehler erkennt, WELCHE Registrierung
    belegt ist.
    """
    await session.execute(
        delete(modell).where(modell.token == token, modell.user_id != user_id)
    )
    vorhanden = await _zeile_des_geraets(session, modell, user_id, geraet_id)
    if vorhanden is not None:
        vorhanden.token = token
    else:
        session.add(modell(user_id=user_id, geraet_id=geraet_id, token=token))
    try:
        await session.commit()
        return
    except IntegrityError:
        await session.rollback()

    # Zweiter Durchgang: der andere Aufruf hat die Zeile gewonnen. Den
    # Überlebenden explizit auf DEN hier angekommenen Token ziehen.
    uebrig = await _zeile_des_geraets(session, modell, user_id, geraet_id)
    if uebrig is None:
        # Kein Rennen um die Zeile — ein anderer Grund (etwa die
        # Token-Eindeutigkeit gegen ein parallel wanderndes Gerät). Ehrlich
        # scheitern statt Erfolg behaupten; der App-Start wiederholt.
        raise HTTPException(status.HTTP_409_CONFLICT, detail=konflikt_detail) from None
    uebrig.token = token
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, detail=konflikt_detail) from None


async def entfernen(
    *, session: Any, modell: type[Any], user_id: int, token: str
) -> None:
    """Die Zeile dieses Tokens entfernen — nur die des eigenen Kontos.

    Ohne die ``user_id``-Bedingung könnte ein Konto die Registrierung eines
    fremden Geräts löschen, indem es dessen Token vorlegt.
    """
    await session.execute(
        delete(modell).where(modell.token == token, modell.user_id == user_id)
    )
    await session.commit()
