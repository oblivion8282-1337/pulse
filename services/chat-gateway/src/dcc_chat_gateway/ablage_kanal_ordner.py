"""Der Ableger — ein eingelieferter Postfach-Umschlag landet zusaetzlich als
Datei im Kanal-Ordner seines Erstellers (Entwurf 2026-09-02, §2-3).

**Wie das zum Postfach steht.** ``POST /postfach`` legt eine ``DmNutzlast``
an, egal ob der Kanal ein Ablage-Kanal ist — das Postfach ist der einzige
Zustellweg (CLAUDE.md: „ohne App-Geraet keine Direktnachrichten"). Ist der
Kanal zusaetzlich ein Ordner-Kanal (``AblageKanalOrdner``-Zeile vorhanden),
legt diese Datei den Umschlag zusaetzlich unter ``kanaele/<channel_id>/`` im
Konto-Laufwerk des Erstellers ab — das ist die Festigung, die einen
verstrichenen Umschlag (Postfach-Verfall) ueberdauert.

**Ablauf statt Nachrichtenverlauf.** Wie beim Anhang-Archiv gilt: der
Server sieht nur Chiffrat, und er schreibt an eine Adresse, die er nie
zurueckgibt. Schlaegt der Schreibversuch fehl (Nextcloud kurz nicht
erreichbar), entsteht eine ``AblageKanalNachtrag``-Zeile — die Pflege holt
sie ueber ``nachtrag_sweep`` nach, statt den Umschlag stillschweigend
verloren zu geben.

Modulweite Namen ``schreibe_aufs_laufwerk``/``ordner_anlegen_am_laufwerk``
als Import-Aliase — Tests ersetzen sie per ``monkeypatch.setattr`` (Muster
``test_postfach_anhaenge_laufwerk.py::_LaufwerkMock``), statt das ganze
HTTP-Verhalten von ``ablage_schreiben`` mitzusimulieren.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.ablage_schreiben import ordner_anlegen as ordner_anlegen_am_laufwerk
from dcc_chat_gateway.ablage_schreiben import schreibe as schreibe_aufs_laufwerk
from dcc_chat_gateway.ablage_ssrf import AblageAbrufFehler
from dcc_chat_gateway.models import (
    AblageKanalNachtrag,
    AblageKanalOrdner,
    AblageKontoLaufwerk,
    DmNutzlast,
)
from dcc_chat_gateway.schemas import PostfachZustellungOut


def ordner_pfad(channel_id: int) -> str:
    """Der Kanal-Ordner, relativ zum Konto-Laufwerk seines Erstellers."""
    return f"kanaele/{channel_id}"


def datei_name(nutzlast_id: int) -> str:
    return f"{nutzlast_id}.puls"


def datei_inhalt(n: DmNutzlast) -> bytes:
    """Derselbe Wire-Umschlag wie beim Abholen (``PostfachZustellungOut``),
    als JSON — damit ein Nachziehen aus dem Ordner denselben Parser
    benutzen kann wie das normale Abholen. IDs laufen als Strings ueber die
    Grenze (CLAUDE.md: Snowflake-IDs als Strings), ``daten`` bleibt
    unveraendertes Base64."""
    zustellung = PostfachZustellungOut.model_validate(n, from_attributes=True)
    return zustellung.model_dump_json().encode()


async def ablegen(session: AsyncSession, nutzlast: DmNutzlast) -> bool:
    """Legt ``nutzlast`` im Kanal-Ordner ab, falls der Kanal einer ist.

    ``False``, wenn der Kanal ueberhaupt kein Ordner-Kanal ist — der
    gewoehnliche Fall, kein Fehler. Ist er einer, aber fehlt dem Ersteller
    ein Konto-Laufwerk (abgehaengt oder nie gesetzt), wirft es
    ``AblageAbrufFehler("kein_laufwerk")`` — der Aufrufer entscheidet, ob
    daraus ein Nachtrag wird. Ein Nextcloud-Ausfall waehrend des Schreibens
    wirft ``AblageAbrufFehler`` aus ``ablage_schreiben`` unveraendert durch.
    """
    ordner_zeile = await session.get(AblageKanalOrdner, nutzlast.channel_id)
    if ordner_zeile is None:
        return False

    laufwerk = await session.get(AblageKontoLaufwerk, ordner_zeile.ersteller_id)
    if laufwerk is None:
        raise AblageAbrufFehler("kein_laufwerk")

    pfad = ordner_pfad(nutzlast.channel_id)
    await ordner_anlegen_am_laufwerk(basis=laufwerk.freigabe_adresse, pfad=pfad)
    await schreibe_aufs_laufwerk(
        basis=laufwerk.freigabe_adresse,
        pfad=f"{pfad}/{datei_name(nutzlast.id)}",
        inhalt=datei_inhalt(nutzlast),
    )
    return True


async def nachtrag_sweep(session: AsyncSession) -> int:
    """Holt liegen gebliebene Nachtraege nach. Gibt die Anzahl der Zeilen
    zurueck, die diesmal erfolgreich geschrieben und deshalb geloescht
    wurden — eine Zeile, die wieder scheitert, bleibt fuer den naechsten
    Lauf stehen."""
    zeilen = (await session.execute(select(AblageKanalNachtrag))).scalars().all()
    erledigt = 0
    for zeile in zeilen:
        nutzlast = await session.get(DmNutzlast, zeile.nutzlast_id)
        if nutzlast is None:
            # Die Nutzlast ist inzwischen verfallen (Postfach-Pflege) — der
            # Nachtrag ist damit gegenstandslos, nicht mehr nachholbar.
            await session.delete(zeile)
            erledigt += 1
            continue
        try:
            await ablegen(session, nutzlast)
        except AblageAbrufFehler:
            continue
        await session.delete(zeile)
        erledigt += 1
    await session.commit()
    return erledigt


async def festige_archiv_markierungen(
    session: AsyncSession,
    angelegte: list[tuple[DmNutzlast, bool]],
    *,
    ableger: Callable[[AsyncSession, DmNutzlast], Awaitable[bool]],
) -> None:
    """Der Ablage-Block aus ``routes/postfach.py`` (Task 4) — hier statt
    dort, damit die Route unter der Groessen-Policy bleibt. ``ableger`` kommt
    als Parameter (nicht der modulweite Name ``ablegen``), damit
    ``routes/postfach.py`` seinen eigenen, test-patchbaren Namen
    ``ablegen_im_ordner`` durchreichen kann, statt hier den unpatchbaren
    Direktaufruf zu verstecken.

    Nur Nutzlasten mit ``archiv: True`` — ein Ordner-Kanal entscheidet
    ``ableger`` selbst mit ``False``, hier wird das nicht vorgeprueft.
    Scheitert das Ablegen, bleibt die Antwort der Route ein Erfolg: der
    Umschlag ist zugestellt, nur die Festigung fehlt noch und holt sich die
    Pflege ueber den Nachtrag (``cleanup.py``).
    """
    zu_committen = False
    for nutzlast, archiv in angelegte:
        if not archiv:
            continue
        zu_committen = True
        try:
            await ableger(session, nutzlast)
        except AblageAbrufFehler:
            session.add(
                AblageKanalNachtrag(nutzlast_id=nutzlast.id, channel_id=nutzlast.channel_id)
            )
    if zu_committen:
        await session.commit()


__all__ = [
    "ordner_pfad",
    "datei_name",
    "datei_inhalt",
    "ablegen",
    "nachtrag_sweep",
    "festige_archiv_markierungen",
]
