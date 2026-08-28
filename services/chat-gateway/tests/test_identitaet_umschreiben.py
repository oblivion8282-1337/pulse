"""Bestandszeilen von der synthetischen ID auf die Cloud-Kennung heben.

Der erste Test prüft **jede einzelne** Spalte, nicht stichprobenartig: Eine
vergessene Spalte fällt sonst erst Monate später als verwaister Datensatz auf,
und dann ist die Ursache nicht mehr auffindbar.

Er füllt die Pflichtspalten dabei **generisch** aus dem Schema statt sie je
Tabelle abzuschreiben. Das ist der Punkt: Kommt eine Tabelle dazu, muss sie in
``SPALTEN`` auftauchen, und dieser Test erfasst sie dann ohne Zutun. Eine
handgeschriebene Einfügezeile je Tabelle hätte genau die Eigenschaft nicht.

Der zweite Test prüft die gefährlichere Hälfte — die bedingten Spalten.
``target_id`` heisst nicht nach einem Nutzer und ist es nur manchmal; nähme die
Umschreibung sie blind mit, verlöre ein Kanal seine Rollen-Rechte, und zwar
lautlos.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text

from dcc_chat_gateway.identitaet_umschreiben import SPALTEN, TEXT_SPALTEN, umschreiben

ALT = 4611686018427387904
NEU = 73315227868860416


async def _pflichtspalten(session, tabelle: str) -> list[tuple[str, str]]:
    """``(name, typ)`` aller Spalten, die beim Einfügen gesetzt werden müssen.

    NOT NULL ohne Vorgabewert. SQLite liefert das über ``PRAGMA table_info``;
    die Testschiene läuft auf aiosqlite (Prod ist Postgres, aber das Schema
    entsteht aus denselben Modellen).
    """
    zeilen = (await session.execute(text(f"PRAGMA table_info({tabelle})"))).fetchall()
    return [
        (z[1], (z[2] or "").upper())
        for z in zeilen
        if z[3] == 1 and z[4] is None  # notnull=1, dflt_value=NULL
    ]


#: Läuft je Einfügung weiter, damit zwei Zeilen derselben Tabelle nicht
#: dieselbe Primärschlüssel-Zahl bekommen (``community_invite_notifications``
#: trägt zwei Nutzerspalten und wird deshalb zweimal befüllt).
_zaehler = 0


def _fuellwert(typ: str, i: int):
    """Irgendein gültiger Wert des Typs — der Inhalt spielt keine Rolle."""
    if "CHAR" in typ or "TEXT" in typ or "CLOB" in typ:
        return f"x{i}"
    if "BOOL" in typ:
        return 0
    if "DATE" in typ or "TIME" in typ:
        return "2026-08-28 00:00:00"
    if "JSON" in typ or "BLOB" in typ:
        return "{}"
    return 1000 + i


async def _zeile_einfuegen(session, tabelle: str, spalte: str, wert) -> None:
    """Legt eine Zeile an, in der ``spalte`` den gewünschten Wert trägt."""
    global _zaehler
    _zaehler += 1
    pflicht = await _pflichtspalten(session, tabelle)
    werte: dict[str, object] = {}
    for i, (name, typ) in enumerate(pflicht):
        werte[name] = _fuellwert(typ, _zaehler * 100 + i)
    werte[spalte] = wert
    namen = ", ".join(werte)
    platzhalter = ", ".join(f":{n}" for n in werte)
    await session.execute(
        text(f"INSERT INTO {tabelle} ({namen}) VALUES ({platzhalter})").bindparams(**werte)
    )


@pytest.mark.asyncio
async def test_jede_einzelne_spalte_wandert(session_factory):
    async with session_factory() as s:
        for tabelle, spalte in SPALTEN:
            await _zeile_einfuegen(s, tabelle, spalte, ALT)
        for tabelle, spalte in TEXT_SPALTEN:
            await _zeile_einfuegen(s, tabelle, spalte, "altes_pw")
        await s.commit()

    async with session_factory() as s:
        await umschreiben(
            s, alt_uid=ALT, neu_uid=NEU, alt_text="altes_pw", neu_text=str(NEU)
        )
        await s.commit()

    async with session_factory() as s:
        for tabelle, spalte in SPALTEN:
            uebrig = (
                await s.execute(
                    text(f"SELECT count(*) FROM {tabelle} WHERE {spalte} = :v").bindparams(
                        v=ALT
                    )
                )
            ).scalar_one()
            assert uebrig == 0, f"{tabelle}.{spalte} wurde nicht umgeschrieben"
        for tabelle, spalte in TEXT_SPALTEN:
            uebrig = (
                await s.execute(
                    text(f"SELECT count(*) FROM {tabelle} WHERE {spalte} = :v").bindparams(
                        v="altes_pw"
                    )
                )
            ).scalar_one()
            assert uebrig == 0, f"{tabelle}.{spalte} wurde nicht umgeschluesselt"


@pytest.mark.asyncio
async def test_bedingte_spalte_ruehrt_rollen_nicht_an(session_factory):
    """``permission_overwrites.target_id`` traegt bei ``target_type=0`` eine ROLLE.

    Naehme die Umschreibung sie mit, verloere ein Kanal seine Rollen-Rechte —
    lautlos, weil niemand nach einer Rechte-Zeile sucht, die es noch gibt, aber
    auf die falsche Kennung zeigt.
    """
    async with session_factory() as s:
        await s.execute(
            text(
                "INSERT INTO permission_overwrites "
                "(channel_id, target_type, target_id, allow_bf, deny_bf) "
                "VALUES (1, 0, :v, 0, 0), (2, 1, :v, 0, 0)"
            ).bindparams(v=ALT)
        )
        await s.commit()
        await umschreiben(s, alt_uid=ALT, neu_uid=NEU, alt_text="x", neu_text=str(NEU))
        await s.commit()

        rolle = (
            await s.execute(
                text("SELECT target_id FROM permission_overwrites WHERE target_type = 0")
            )
        ).scalar_one()
        nutzer = (
            await s.execute(
                text("SELECT target_id FROM permission_overwrites WHERE target_type = 1")
            )
        ).scalar_one()

    assert rolle == ALT, "die Rolle wurde faelschlich mitgenommen"
    assert nutzer == NEU, "der Nutzer wurde nicht umgeschrieben"


@pytest.mark.asyncio
async def test_kollision_bricht_ab_statt_zu_ueberschreiben(session_factory):
    """Traegt die Ziel-Kennung schon eine andere Identitaet, wird nicht geschrieben.

    Rechnerisch ist das ausgeschlossen (63-bit-Abdruck gegen Snowflake). Das ist
    kein Grund, die Pruefung wegzulassen, wenn sie eine Zeile kostet — ein
    stiller Fehltreffer waere hier nicht zurueckzunehmen.
    """
    async with session_factory() as s:
        await _zeile_einfuegen(s, "guild_members", "user_id", ALT)
        await _zeile_einfuegen(s, "guild_members", "user_id", NEU)
        await s.commit()
        with pytest.raises(ValueError, match="Kollision"):
            await umschreiben(s, alt_uid=ALT, neu_uid=NEU, alt_text="x", neu_text=str(NEU))


# ---------------------------------------------------------------------------
# Der eigentliche Prüfstein
# ---------------------------------------------------------------------------
#
# Die drei Tests oben prüfen die MECHANIK der Umschreibung. Sie können eine
# vergessene Spalte grundsätzlich nicht finden: Sie beziehen ihre Erwartung aus
# ``SPALTEN``, fügen also nur ein, was ohnehin drinsteht. Eine Gegenprobe hat
# das belegt — ``messages.author_id`` aus der Liste genommen, alle drei blieben
# grün.
#
# Dieser Test dreht die Richtung um: Er liest die Spalten aus den MODELLEN und
# verlangt, dass jede davon in einer der Listen vorkommt oder ausdrücklich als
# ausgelassen vermerkt ist. Damit schlägt er an, wenn eine Tabelle dazukommt —
# und das ist der Fall, den niemand von Hand bemerkt.

#: Bewusst nicht umgeschrieben, mit Grund. Wer hier etwas einträgt, begründet es.
BEWUSST_AUSGELASSEN: dict[tuple[str, str], str] = {
    ("admin_audit_log", "target_id"): (
        "Kein Diskriminator: Die Tabelle hat keine Typspalte, der Typ steckt "
        "implizit in ``action``. Eine Umschreibung waere entweder unvollstaendig "
        "oder uebergriffig."
    ),
}

#: Spaltennamen, die eine Kennung tragen, ohne nach einem Nutzer zu heissen.
#: Sie muessen klassifiziert sein — als bedingt oder als ausgelassen.
_VERDAECHTIG = ("target_id", "subject_id")


def _spalten_aus_modellen() -> set[tuple[str, str]]:
    import pathlib
    import re

    mdir = pathlib.Path(__file__).resolve().parents[1] / "src/dcc_chat_gateway/models"
    gefunden: set[tuple[str, str]] = set()
    muster = re.compile(
        r"\s*(\w*(?:user_id|author_id|owner_id|actor_id|user_identifier|"
        r"synthetic_user_id|target_id|subject_id))\s*:\s*Mapped"
    )
    for f in sorted(mdir.glob("*.py")):
        tabelle = None
        for zeile in f.read_text().splitlines():
            m = re.search(r'__tablename__\s*=\s*["\']([^"\']+)', zeile)
            if m:
                tabelle = m.group(1)
            m2 = muster.match(zeile)
            if m2 and tabelle:
                gefunden.add((tabelle, m2.group(1)))
    return gefunden


def test_keine_spalte_faellt_aus_der_liste():
    """Jede Spalte, die eine Kennung tragen kann, ist klassifiziert.

    Schlaegt an, sobald eine neue Tabelle mit einer Nutzerspalte dazukommt. Ohne
    diesen Test faende man sie erst, wenn nach der Umschreibung Zeilen auf eine
    Kennung zeigen, die es nicht mehr gibt — und dann ist die Ursache nicht mehr
    auffindbar.
    """
    from dcc_chat_gateway.identitaet_umschreiben import BEDINGTE_SPALTEN

    abgedeckt = (
        set(SPALTEN)
        | {(t, s) for t, s, _, _ in BEDINGTE_SPALTEN}
        | set(TEXT_SPALTEN)
        | set(BEWUSST_AUSGELASSEN)
    )
    fehlend = _spalten_aus_modellen() - abgedeckt
    assert not fehlend, (
        "Nicht klassifizierte Spalten mit Nutzerkennung: "
        f"{sorted(fehlend)} — in SPALTEN, BEDINGTE_SPALTEN, TEXT_SPALTEN "
        "aufnehmen oder in BEWUSST_AUSGELASSEN begruenden."
    )


def test_die_erhebung_findet_ueberhaupt_etwas():
    """Gegenprobe zur Gegenprobe: Ein leeres Ergebnis waere ein gruener Test
    ohne Aussage — genau die Falle, die der Prüfstein oben aufdecken soll."""
    gefunden = _spalten_aus_modellen()
    assert len(gefunden) > 20, f"Erhebung liefert nur {len(gefunden)} Spalten"
    assert ("messages", "author_id") in gefunden
    for name in _VERDAECHTIG:
        assert any(s == name for _, s in gefunden), f"{name} nicht gefunden"
