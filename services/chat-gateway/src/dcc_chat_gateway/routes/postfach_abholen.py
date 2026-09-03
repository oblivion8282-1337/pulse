"""Das Postfach — Abholen und Quittieren (Etappe D, Task 3).

``POST /postfach/abholen`` liefert die offenen Zustellungen des anfragenden
Geraets, aelteste zuerst. **Abholen loescht nicht** — geloescht wird erst auf
Quittung (``POST /postfach/quittung``). Anders waere jede verlorene Antwort
ein verlorener Umschlag, und weil es kein serverseitiges Backup gibt, waere
er endgueltig weg. Der Preis: ein Klient, der nie quittiert, behaelt seine
Zustellungen bis zur Frist (``postfach_pflege.py`` raeumt sie dann von
selbst) — das ist die richtige Richtung, in die man sich irrt.

Beide Routen nennen das Geraet im Rumpf und lassen es von
``schluessel_nachweis.py::pruefe_geraet`` gegen das angemeldete Konto
halten — ohne diese Angabe kennt der Server nur das KONTO
(``CurrentUser``), nie das GERAET, und ein Umschlag ist fuer genau ein
Empfaengergeraet verschluesselt. Die Quittung filtert deshalb IMMER
zusaetzlich auf das genannte Empfaengergeraet UND das angemeldete Konto,
nie nur auf die Zustellungs-ID — eine erratene ID darf nicht die
Zustellung eines anderen loeschen.

**Was das seit dem Wegfall der Zertifikate nicht mehr leistet** (Spec §3b,
ausfuehrlich in ``schluessel_nachweis.py::pruefe_geraet``): dass der
Aufrufer dieses Geraet IST. Wer eine Kontositzung uebernimmt, kann die
offenen Umschlaege JEDES Geraets des Kontos abholen und wegquittieren.
Entschluesseln kann er sie nicht — wegnehmen schon.
"""

from __future__ import annotations

from fastapi import APIRouter, Response, status
from sqlalchemy import delete, exists, select

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import (
    AblageKanalNachtrag,
    DeviceKeyBundle,
    DmNutzlast,
    DmZustellung,
)
from dcc_chat_gateway.schemas import (
    PostfachAbholenRequest,
    PostfachQuittungRequest,
    PostfachZustellungOut,
)
from dcc_chat_gateway.schluessel_nachweis import pruefe_geraet
from dcc_chat_gateway.security import CurrentUser

router = APIRouter(tags=["postfach"])


@router.post("/postfach/abholen", response_model=list[PostfachZustellungOut])
async def postfach_abholen(
    body: PostfachAbholenRequest,
    session: SessionDep,
    user: CurrentUser,
) -> list[PostfachZustellungOut]:
    """Gibt die offenen Zustellungen des genannten Geraets zurueck.

    Zweimal ohne Quittung abgeholt liefert dasselbe — es wird hier nichts
    geloescht (s. Modul-Docstring).
    """
    geraet = await pruefe_geraet(session, user, body.device_pubkey)

    zeilen = (
        await session.execute(
            select(
                DmZustellung.id,
                DmNutzlast.channel_id,
                DmNutzlast.absender_device_pubkey,
                DmNutzlast.absender_curve25519,
                # Wer die Zustellung geschrieben hat, NICHT der Kanal-
                # Gegenpart — eine verschluesselte DM liefert auch an die
                # eigenen anderen Geraete des Senders aus (s.
                # ``PostfachZustellungOut.absender_user_id``). Ein OUTER Join:
                # das Sendegeraet kann sich zwischen Einliefern und Abholen
                # abgemeldet haben, dann ist sein Buendel weg und die Spalte
                # NULL, statt dass die ganze Zustellung fehlt.
                DeviceKeyBundle.user_id.label("absender_user_id"),
                DmNutzlast.art,
                DmNutzlast.daten,
                DmNutzlast.groesse,
                DmNutzlast.created_at,
            )
            .join(DmNutzlast, DmNutzlast.id == DmZustellung.nutzlast_id)
            .outerjoin(
                DeviceKeyBundle,
                DeviceKeyBundle.device_pubkey == DmNutzlast.absender_device_pubkey,
            )
            .where(
                # NICHT nur auf den Empfaenger-Pubkey filtern (obwohl er
                # faktisch geraeteweit eindeutig ist) — das Konto zusaetzlich
                # zu binden ist die gleiche Verteidigung wie bei der
                # Quittung: zwei unabhaengige Bedingungen statt einer.
                DmZustellung.empfaenger_device_pubkey == geraet,
                DmZustellung.empfaenger_user_id == user.id,
            )
            .order_by(DmZustellung.id)
        )
    ).all()

    # Die Spalten oben heissen genau wie die Felder des Schemas — deshalb
    # ``model_validate`` (``from_attributes=True``) statt einer Zuweisung je
    # Feld: eine neue Spalte waere sonst an zwei Stellen nachzutragen, und die
    # vergessene zweite faellt erst beim Klienten auf.
    return [PostfachZustellungOut.model_validate(zeile) for zeile in zeilen]


@router.post("/postfach/quittung", status_code=status.HTTP_204_NO_CONTENT)
async def postfach_quittung(
    body: PostfachQuittungRequest,
    session: SessionDep,
    user: CurrentUser,
) -> Response:
    """Loescht die genannten Zustellungen des genannten Geraets.

    Eine ID, die nicht zu diesem Geraet/Konto gehoert, wird stillschweigend
    ignoriert — wie beim unbekannten Empfaengergeraet in ``routes/postfach.py``
    ist eine erratene oder inzwischen fremde ID kein Fehlerfall fuer den
    Rest der Liste.
    """
    ids = list(dict.fromkeys(body.zustellung_ids))  # Duplikate raus, Reihenfolge egal.
    geraet = await pruefe_geraet(session, user, body.device_pubkey)

    betroffene_nutzlasten = (
        await session.execute(
            delete(DmZustellung)
            .where(
                DmZustellung.id.in_(ids),
                DmZustellung.empfaenger_device_pubkey == geraet,
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
    #
    # **Der zweite EXISTS ist ein Wettlauf-Riegel** (Entwurf 2026-09-02,
    # Fixwelle 2): traegt die Nutzlast einen Nachtrag („Festigung offen",
    # angelegt im Einliefer-Commit), steht ihre Ablage im Kanal-Ordner noch
    # aus — die laeuft als Hintergrundaufgabe NACH der Antwort auf
    # ``POST /postfach``, und ein schnell quittierendes Geraet war
    # regelmaessig frueher dran. Ohne diesen Riegel loeschte die Quittung
    # die Nutzlast, und die Festigung fand nichts mehr vor: die Nachricht
    # fehlte im dauerhaften Bestand des Kanals, obwohl genau er der Zweck
    # des Ordner-Kanals ist. Dieselbe Bedingung steht in
    # ``postfach_pflege.py::sweep_verwaiste_nutzlasten``.
    for nutzlast_id in set(betroffene_nutzlasten):
        await session.execute(
            delete(DmNutzlast).where(
                DmNutzlast.id == nutzlast_id,
                ~exists(
                    select(DmZustellung.id).where(
                        DmZustellung.nutzlast_id == nutzlast_id
                    )
                ),
                ~exists(
                    select(AblageKanalNachtrag.nutzlast_id).where(
                        AblageKanalNachtrag.nutzlast_id == nutzlast_id
                    )
                ),
            )
        )

    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
