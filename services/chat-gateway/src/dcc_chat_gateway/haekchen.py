"""Die Häkchen-Treppe am Server: Lese- und Zustellstände für DMs und private
Gruppen (gesendet → zugestellt → gelesen, WhatsApp-Semantik).

Eine Stelle für drei Fragen, die vorher über ``dms.py``, ``ws_ready.py`` und
``private_gruppen.py`` verteilt hätten stehen müssen:

* **Was darf ein Konto über die Gegenstelle erfahren?** In DMs nur, wenn
  BEIDE Lesebestätigungen eingeschaltet haben (``user_privacy``, Migration
  0101 — die WhatsApp-Regel: wer seine abschaltet, sieht auch fremde nicht).
  Der Zustellstand (doppelt grau) ist davon unberührt, und Gruppen sind
  ausgenommen — sonst würde eine Nachricht nie blau, sobald ein einziges
  Mitglied abschaltet.
* **Was wird gespeichert?** Der Zustellstand kommt mit der Quittung des
  Empfängers (``postfach_abholen.py``) und ist eine kanonische Nachrichten-ID
  JE ABSENDER: nur gegen seine eigenen IDs vergleicht der Absender ohne
  Uhrzeitversatz.
* **Was räumt eine Löschung mit?** ``zustellstand`` zeigt polymorph auf DM
  oder Gruppe und hat keinen Fremdschlüssel — die Löschstellen rufen die
  ``*_loeschen``-Funktionen unten.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from sqlalchemy import delete as sa_delete
from sqlalchemy import func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from dcc_chat_gateway.dm_vorschau import lesestaende
from dcc_chat_gateway.friend_privacy import DEFAULT_LESEBESTAETIGUNGEN
from dcc_chat_gateway.models import (
    DirectMessageChannel,
    GruppenLesestand,
    UserPrivacy,
    Zustellstand,
)


@dataclass(frozen=True)
class DmStaende:
    """Was ein DM-Teilnehmer über seine Unterhaltung erfährt."""

    eigener_gelesen: int | None
    partner_gelesen: int | None
    partner_zugestellt: int | None


@dataclass(frozen=True)
class MitgliedStaende:
    """Je Gruppenmitglied, aus Sicht des Aufrufers als Absender."""

    gelesen_bis: int | None
    zugestellt_bis: int | None


async def lesebestaetigung_an(session, user_ids: Iterable[int]) -> dict[int, bool]:
    """Der Schalter je Konto; ohne Zeile gilt die Vorgabe (an)."""
    ids = list(set(user_ids))
    stand = dict.fromkeys(ids, DEFAULT_LESEBESTAETIGUNGEN)
    if not ids:
        return stand
    zeilen = await session.execute(
        select(UserPrivacy.user_id, UserPrivacy.lesebestaetigungen).where(
            UserPrivacy.user_id.in_(ids)
        )
    )
    stand.update({uid: bool(an) for uid, an in zeilen.all()})
    return stand


async def dm_lesestand_empfaenger(session, leser_id: int, partner_id: int) -> list[int]:
    """Wer das ``dm_lesestand``-Ereignis bekommt. Der Lesende selbst immer —
    seine anderen Geräte löschen damit ihre Zähler (P0.2), das ist keine
    Lesebestätigung. Die Gegenstelle nur, wenn beide sie teilen."""
    an = await lesebestaetigung_an(session, (leser_id, partner_id))
    if an[leser_id] and an[partner_id]:
        return [leser_id, partner_id]
    return [leser_id]


async def _zustellstaende_als_absender(
    session, absender_id: int, kanal_ids: list[int]
) -> dict[tuple[int, int], int]:
    """(Kanal, Empfänger) → zugestellt_bis für Nachrichten des Absenders."""
    if not kanal_ids:
        return {}
    zeilen = await session.execute(
        select(
            Zustellstand.channel_id,
            Zustellstand.empfaenger_user_id,
            Zustellstand.zugestellt_bis,
        ).where(
            Zustellstand.channel_id.in_(kanal_ids),
            Zustellstand.absender_user_id == absender_id,
        )
    )
    return {(kanal, empf): bis for kanal, empf, bis in zeilen.all()}


async def dm_staende(
    session, user_id: int, dms: list[DirectMessageChannel]
) -> dict[int, DmStaende]:
    """Lese- und Zustellstände je DM aus Sicht von ``user_id`` — für den
    ``ready``-Rahmen und ``GET /dm-channels`` (dieselbe Quelle für beide,
    sonst überschreibt der eine den anderen im Klienten)."""
    if not dms:
        return {}
    kanal_ids = [d.id for d in dms]
    partner = {d.id: d.user_b_id if d.user_a_id == user_id else d.user_a_id for d in dms}
    lese = await lesestaende(session, kanal_ids)
    zugestellt = await _zustellstaende_als_absender(session, user_id, kanal_ids)
    an = await lesebestaetigung_an(session, [user_id, *partner.values()])
    out: dict[int, DmStaende] = {}
    for kanal, gegenueber in partner.items():
        geteilt = an[user_id] and an[gegenueber]
        out[kanal] = DmStaende(
            eigener_gelesen=lese.get((kanal, user_id)),
            partner_gelesen=lese.get((kanal, gegenueber)) if geteilt else None,
            partner_zugestellt=zugestellt.get((kanal, gegenueber)),
        )
    return out


async def gruppen_staende(
    session, user_id: int, gruppe_ids: list[int]
) -> dict[int, dict[int, MitgliedStaende]]:
    """Gruppe → Mitglied → Stände. Gelesen gilt für alle Mitglieder (auch den
    Aufrufer selbst: daraus löschen seine anderen Geräte ihre Zähler),
    zugestellt nur für Nachrichten des Aufrufers."""
    if not gruppe_ids:
        return {}
    gelesen = await session.execute(
        select(
            GruppenLesestand.gruppe_id,
            GruppenLesestand.user_id,
            GruppenLesestand.last_read_message_id,
        ).where(GruppenLesestand.gruppe_id.in_(gruppe_ids))
    )
    lese: dict[tuple[int, int], int] = {(g, u): bis for g, u, bis in gelesen.all()}
    zugestellt = await _zustellstaende_als_absender(session, user_id, gruppe_ids)
    out: dict[int, dict[int, MitgliedStaende]] = {}
    for g, u in set(lese) | set(zugestellt):
        out.setdefault(g, {})[u] = MitgliedStaende(
            gelesen_bis=lese.get((g, u)), zugestellt_bis=zugestellt.get((g, u))
        )
    return out


async def zustellstaende_speichern(
    session,
    empfaenger_id: int,
    eintraege: Iterable[tuple[int, int, int]],
    erlaubt: set[tuple[int, int]],
) -> list[tuple[int, int, int]]:
    """Monotoner Upsert der (Kanal, Absender, bis)-Meldungen eines Empfängers.

    Nur Paare aus ``erlaubt`` zählen — die Quittung muss tatsächlich
    Umschläge dieses Absenders in diesem Kanal betroffen haben; ein Klient
    kann sich so keinen Stand in einem fremden Kanal ausdenken. Die eigene
    Zustellung (Zweitgerät) ist kein Fall für den Haken. Rückgabe: die danach
    GELTENDEN Stände (ein veralteter Wert schiebt nichts zurück, das
    Ereignis trägt dann den gespeicherten)."""
    geltend: list[tuple[int, int, int]] = []
    for kanal, absender, bis in eintraege:
        if (kanal, absender) not in erlaubt or absender == empfaenger_id:
            continue
        einfuegen = pg_insert(Zustellstand).values(
            channel_id=kanal,
            absender_user_id=absender,
            empfaenger_user_id=empfaenger_id,
            zugestellt_bis=bis,
        )
        neu = einfuegen.excluded.zugestellt_bis
        await session.execute(
            einfuegen.on_conflict_do_update(
                index_elements=[
                    Zustellstand.channel_id,
                    Zustellstand.absender_user_id,
                    Zustellstand.empfaenger_user_id,
                ],
                set_={"zugestellt_bis": neu, "aktualisiert_am": func.now()},
                where=neu > Zustellstand.zugestellt_bis,
            )
        )
        gespeichert = (
            await session.execute(
                select(Zustellstand.zugestellt_bis).where(
                    Zustellstand.channel_id == kanal,
                    Zustellstand.absender_user_id == absender,
                    Zustellstand.empfaenger_user_id == empfaenger_id,
                )
            )
        ).scalar_one()
        geltend.append((kanal, absender, gespeichert))
    return geltend


async def kanaele_loeschen(session, kanal_ids: Iterable[int]) -> None:
    """Zustellstände gelöschter DMs/Gruppen (kein Fremdschlüssel, s. oben)."""
    ids = list(kanal_ids)
    if ids:
        await session.execute(sa_delete(Zustellstand).where(Zustellstand.channel_id.in_(ids)))


async def mitglied_loeschen(session, gruppe_id: int, user_id: int) -> None:
    """Wer eine Gruppe verlässt, nimmt seine Stände mit — als Leser und als
    Absender. Ein späterer Wiedereintritt beginnt ohne Altlast."""
    await session.execute(
        sa_delete(Zustellstand).where(
            Zustellstand.channel_id == gruppe_id,
            or_(
                Zustellstand.absender_user_id == user_id,
                Zustellstand.empfaenger_user_id == user_id,
            ),
        )
    )
    await session.execute(
        sa_delete(GruppenLesestand).where(
            GruppenLesestand.gruppe_id == gruppe_id, GruppenLesestand.user_id == user_id
        )
    )


async def konto_loeschen(session, user_id: int) -> None:
    """Konto-Purge: jede Zeile, in der das Konto vorkommt. ``dm_lesestand``
    räumt die DM-Kaskade, ``gruppen_lesestand`` hätte ohne diese Zeile die
    Lesestände eines gelöschten Kontos in fortbestehenden Gruppen behalten."""
    await session.execute(
        sa_delete(Zustellstand).where(
            or_(
                Zustellstand.absender_user_id == user_id,
                Zustellstand.empfaenger_user_id == user_id,
            )
        )
    )
    await session.execute(sa_delete(GruppenLesestand).where(GruppenLesestand.user_id == user_id))
