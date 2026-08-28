"""Das Postfach — Abholen und Quittieren (Etappe D, Task 3).

``POST /postfach/abholen`` liefert die offenen Zustellungen des anfragenden
Geraets, aelteste zuerst. **Abholen loescht nicht** — geloescht wird erst auf
Quittung (``POST /postfach/quittung``). Anders waere jede verlorene Antwort
ein verlorener Umschlag, und weil es kein serverseitiges Backup gibt, waere
er endgueltig weg. Der Preis: ein Klient, der nie quittiert, behaelt seine
Zustellungen bis zur Frist (``postfach_pflege.py`` raeumt sie dann von
selbst) — das ist die richtige Richtung, in die man sich irrt.

Beide Routen brauchen den Geraete-Nachweis aus ``schluessel_nachweis.py``,
je mit einem EIGENEN Zweck (``"postfach-abholen"`` / ``"postfach-quittung"``,
unterschieden von ``"postfach"`` beim Einliefern und von ``"buendel"``/
``"einmalschluessel"`` beim Schluesselverzeichnis) — ohne diesen Nachweis
kennt der Server nur das KONTO (``CurrentUser``), nie das GERAET, und ein
Umschlag ist fuer genau ein Empfaengergeraet verschluesselt. Die Quittung
filtert deshalb IMMER zusaetzlich auf das nachgewiesene Empfaengergeraet UND
das angemeldete Konto, nie nur auf die Zustellungs-ID — eine erratene ID darf
nicht die Zustellung eines anderen loeschen.
"""

from __future__ import annotations

from fastapi import APIRouter, Request, Response, status
from sqlalchemy import delete, exists, select

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import DmNutzlast, DmZustellung
from dcc_chat_gateway.routes.postfach import _require_redis
from dcc_chat_gateway.schemas import (
    PostfachAbholenRequest,
    PostfachQuittungRequest,
    PostfachZustellungOut,
)
from dcc_chat_gateway.schluessel_nachweis import baue_nutzlast, pruefe_geraet
from dcc_chat_gateway.security import CurrentUser

router = APIRouter(tags=["postfach"])


@router.post("/postfach/abholen", response_model=list[PostfachZustellungOut])
async def postfach_abholen(
    body: PostfachAbholenRequest,
    request: Request,
    session: SessionDep,
    user: CurrentUser,
) -> list[PostfachZustellungOut]:
    """Gibt die offenen Zustellungen des nachgewiesenen Geraets zurueck.

    Zweimal ohne Quittung abgeholt liefert dasselbe — es wird hier nichts
    geloescht (s. Modul-Docstring).
    """
    redis = _require_redis(request)
    nutzlast = baue_nutzlast("postfach-abholen")
    claims = await pruefe_geraet(body.cert, nutzlast, body.signatur, user, redis)

    zeilen = (
        await session.execute(
            select(
                DmZustellung.id,
                DmNutzlast.absender_device_pubkey,
                DmNutzlast.art,
                DmNutzlast.daten,
                DmNutzlast.groesse,
            )
            .join(DmNutzlast, DmNutzlast.id == DmZustellung.nutzlast_id)
            .where(
                # NICHT nur auf den Empfaenger-Pubkey filtern (obwohl er
                # faktisch geraeteweit eindeutig ist) — das Konto zusaetzlich
                # zu binden ist die gleiche Verteidigung wie bei der
                # Quittung: zwei unabhaengige Bedingungen statt einer.
                DmZustellung.empfaenger_device_pubkey == claims.device_pubkey,
                DmZustellung.empfaenger_user_id == user.id,
            )
            .order_by(DmZustellung.id)
        )
    ).all()

    return [
        PostfachZustellungOut(
            id=zeile.id,
            absender_device_pubkey=zeile.absender_device_pubkey,
            art=zeile.art,
            daten=zeile.daten,
            groesse=zeile.groesse,
        )
        for zeile in zeilen
    ]


@router.post("/postfach/quittung", status_code=status.HTTP_204_NO_CONTENT)
async def postfach_quittung(
    body: PostfachQuittungRequest,
    request: Request,
    session: SessionDep,
    user: CurrentUser,
) -> Response:
    """Loescht die genannten Zustellungen des nachgewiesenen Geraets.

    Eine ID, die nicht zu diesem Geraet/Konto gehoert, wird stillschweigend
    ignoriert — wie beim unbekannten Empfaengergeraet in ``routes/postfach.py``
    ist eine erratene oder inzwischen fremde ID kein Fehlerfall fuer den
    Rest der Liste.
    """
    redis = _require_redis(request)
    ids = list(dict.fromkeys(body.zustellung_ids))  # Duplikate raus, Reihenfolge egal.
    nutzlast = baue_nutzlast("postfach-quittung", *[str(i) for i in ids])
    claims = await pruefe_geraet(body.cert, nutzlast, body.signatur, user, redis)

    betroffene_nutzlasten = (
        await session.execute(
            delete(DmZustellung)
            .where(
                DmZustellung.id.in_(ids),
                DmZustellung.empfaenger_device_pubkey == claims.device_pubkey,
                DmZustellung.empfaenger_user_id == user.id,
            )
            .returning(DmZustellung.nutzlast_id)
        )
    ).scalars().all()

    # Eine Nutzlast, die niemand mehr abholen kann, ist Muell — bei einer
    # Gruppe faellt sie erst mit der LETZTEN Zustellung. Entschieden wird
    # ueber "hat sie noch Zustellungen?" (EXISTS), NICHT ueber einen Zaehler
    # in der Nutzlast-Zeile: ein Zaehler haette bei zwei gleichzeitigen
    # Quittungen auf dieselbe Nutzlast einen verlorenen Schreibzugriff
    # (lost update, beide lesen denselben alten Stand). Die EXISTS-Pruefung
    # steckt in DERSELBEN atomaren DELETE-Anweisung wie die Entscheidung
    # selbst — kein separater Lese-dann-Schreib-Schritt dazwischen, an dem
    # ein anderer Vorgang haette eingreifen koennen.
    for nutzlast_id in set(betroffene_nutzlasten):
        await session.execute(
            delete(DmNutzlast).where(
                DmNutzlast.id == nutzlast_id,
                ~exists(
                    select(DmZustellung.id).where(
                        DmZustellung.nutzlast_id == nutzlast_id
                    )
                ),
            )
        )

    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
