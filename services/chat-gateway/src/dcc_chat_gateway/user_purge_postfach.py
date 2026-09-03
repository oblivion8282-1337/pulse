"""Konto-Purge: E2E-Postfach (Geraete-Buendel, Einmalschluessel, Zustellungen).

Abgetrennt von ``user_purge.py`` — derselbe Grund wie bei
``user_purge_gruppen.py``: die Datei laeuft sonst ueber die Groessen-Policy
(PLAN.md §12.1), sie war schon vor dieser Ergaenzung nahe an der Grenze.

Vier Tabellen, drei verschiedene Eigentumsverhaeltnisse:

- ``DeviceKeyBundle`` gehoert dem Konto ueber ``user_id`` — jedes eigene
  Buendel wird geloescht. ``DeviceOneTimeKey`` haengt per FK an einem
  Buendel und wird explizit mitgeraeumt statt ueber die DB-Kaskade zu
  laufen: Tests fahren SQLite ohne ``PRAGMA foreign_keys=ON`` innerhalb
  dieser Transaktion (s. ``test_postfach.py::_enable_sqlite_foreign_keys``,
  das nur die eigene Verbindung des Tests betrifft), eine Kaskade waere dort
  ein Kein-Op, das nur in Produktion griffe.
- ``DmZustellung`` gehoert dem EMPFAENGER (``empfaenger_user_id``) — eine
  Zustellung an ein Geraet dieses Kontos wird niemand mehr abholen, das
  Konto existiert nicht mehr.
- ``DmNutzlast`` gehoert niemandem direkt (kein ``user_id`` auf der Zeile);
  sie faellt weg, sobald ihre letzte Zustellung weg ist — dieselbe Abfrage
  wie ``postfach_pflege.py::sweep_verwaiste_nutzlasten``. Eine Nutzlast, die
  dieses Konto an noch existierende Empfaenger geschickt hat, bleibt
  stehen: deren Zustellungen sind von diesem Purge nicht betroffen.
- Ein verschluesselter Anhang (Etappe E) gehoert ebenfalls niemandem direkt:
  er haengt an Nutzlasten, nicht an einer Nachricht. Faellt mit den obigen
  Nutzlasten sein letzter Umschlag, faellt er mit — Zeile und Klumpen,
  ueber ``postfach_pflege.py::loesche_anhaenge_ohne_umschlag``.

**Dieselbe Faehrte wie bei ``community_invite_notifications`` nach Migration
0063** — dort raeumte der Purge bis heute nicht mit (s. Docstring von
``user_purge_gruppen.py::purge_private_group_memberships``). Diese Etappe
wiederholt sie nicht: der Test dafuer heisst
``test_purge_raeumt_e2e_postfach`` (``tests/test_user_purge.py``).

Kein Commit hier — laeuft innerhalb derselben Transaktion wie der Rest von
``user_purge.py::_purge_db`` (dessen Modul-Docstring: „a half-purge can't
leave dangling rows").
"""

from __future__ import annotations

from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models import DeviceKeyBundle, DeviceOneTimeKey, DmNutzlast, DmZustellung
from dcc_chat_gateway.postfach_pflege import (
    loesche_anhaenge_ohne_umschlag,
    verwaist_bedingungen,
)


async def purge_postfach(session: AsyncSession, user_id: int) -> None:
    """Raeumt Geraete-Buendel + Postfach-Zeilen des geloeschten Kontos."""
    bundle_ids = list(
        (
            await session.execute(
                select(DeviceKeyBundle.id).where(DeviceKeyBundle.user_id == user_id)
            )
        ).scalars()
    )
    if bundle_ids:
        await session.execute(
            sa_delete(DeviceOneTimeKey).where(DeviceOneTimeKey.bundle_id.in_(bundle_ids))
        )
        await session.execute(
            sa_delete(DeviceKeyBundle).where(DeviceKeyBundle.id.in_(bundle_ids))
        )

    await session.execute(
        sa_delete(DmZustellung).where(DmZustellung.empfaenger_user_id == user_id)
    )
    # Verwaiste Nutzlasten nachziehen — buchstäblich DIESELBE Bedingung wie
    # der reguläre Verfallslauf (`verwaist_bedingungen`), damit hier keine
    # zweite, potenziell abweichende Definition von „verwaist" entsteht. Sie
    # schont deshalb auch eine Nutzlast mit offenem Nachtrag: die wandert
    # noch in den Kanal-Ordner und fällt beim nächsten Pflegelauf.
    await session.execute(sa_delete(DmNutzlast).where(*verwaist_bedingungen()))
    # Und die Anhaenge, die mit diesen Nutzlasten ihren letzten Umschlag
    # verloren haben (Etappe E) — wieder DIESELBE Funktion wie im
    # Verfallslauf, kein zweiter Begriff von „verwaist".
    #
    # Der Klumpen faellt hier VOR dem Commit, wie jede andere
    # Objektspeicher-Loeschung dieses Purges (``hard_delete_attachments`` in
    # ``user_purge.py`` laeuft ebenfalls ohne ``defer_s3``). Der Preis ist
    # benannt: bricht der Commit ab, sind die Bytes weg und die Zeilen
    # stehen noch — beim naechsten Anlauf findet dieselbe Abfrage sie
    # wieder, und ein Loeschen im Objektspeicher ohne Gegenstueck ist
    # folgenlos.
    _, schluessel = await loesche_anhaenge_ohne_umschlag(session)
    # Erst hier importiert, nicht oben — nachgemessen: ``routes/attachments``
    # zieht das Paket ``routes`` hoch, das ueber ``routes/internal.py`` und
    # ``user_purge.py`` wieder in DIESE Datei laeuft, die dann erst zur
    # Haelfte ausgefuehrt ist ("cannot import name 'purge_postfach' from
    # partially initialized module"). Dieselbe Stelle wie in
    # ``postfach_pflege.py::sweep_verwaiste_anhaenge``.
    from dcc_chat_gateway.routes.attachments import purge_s3_keys

    await purge_s3_keys(schluessel)


__all__ = ["purge_postfach"]
