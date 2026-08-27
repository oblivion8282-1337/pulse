"""Hält den Textkatalog gegen die Stellen, die Befunde ERZEUGEN.

Warum nicht gegen eine Liste im Test
------------------------------------
Wer eine Prüfung testet, schreibt die Fälle aus derselben Vorstellung auf, aus
der er die Prüfung geschrieben hat — ein Befund, an den beim Bauen niemand
dachte, fehlt dann auch im Test. Deshalb liest dieser Test die Befunde aus dem
Quelltext der beiden Probe-Module: neu erfundene Befunde tauchen hier von
selbst auf, ohne dass jemand daran denken muss.

Was ein Fehlschlag hier bedeutet: irgendwo meldet die Prüfung etwas, wofür es
keinen Satz gibt. Der Nutzer bekäme dann den Sammeltext — kein Absturz, aber
eine Sackgasse, und zwar in dem Moment, in dem er ohnehin ein Problem hat.
"""

from __future__ import annotations

import ast
import pathlib

import pytest

from dcc_auth import diagnose_texte as dt

_QUELLEN = ("selfhost_probe.py", "selfhost_probe_dienst.py", "selfhost_probe_betreiber.py")


def _modul_pfad(name: str) -> pathlib.Path:
    return pathlib.Path(dt.__file__).with_name(name)


def _strings(knoten: ast.AST) -> set[str]:
    """Zeichenketten, die als WERT herauskommen können — nicht jede im Baum.

    Der Unterschied ist nicht theoretisch: bei
    ``"falscher_name" if "hostname" in str(exc) else "nicht_vertrauenswuerdig"``
    ist ``"hostname"`` ein Prüfwort und kein Befund. Ein blindes ``ast.walk``
    nähme es mit und verlangte dafür einen Text, den es nie geben wird.
    """
    if isinstance(knoten, ast.Constant):
        return {knoten.value} if isinstance(knoten.value, str) else set()
    if isinstance(knoten, ast.IfExp):
        return _strings(knoten.body) | _strings(knoten.orelse)
    if isinstance(knoten, ast.Dict):
        return {s for wert in knoten.values for s in _strings(wert)}
    return {
        k.value for k in ast.walk(knoten) if isinstance(k, ast.Constant) and isinstance(k.value, str)
    }


def _aufgeloest(name: str, funktion: ast.AST) -> set[str]:
    """Welche Zeichenketten kann die Variable ``name`` in dieser Funktion tragen?

    Zwei Formen kommen im Bestand vor und beide müssen erfasst werden:
    die direkte Zuweisung (auch als Bedingungsausdruck mit zwei Zweigen) und
    ``kodes.get(...)`` auf ein zuvor zugewiesenes Wörterbuch — dort stehen die
    Befunde in den Werten, nicht am Zuweisungsziel.
    """
    treffer: set[str] = set()
    woerterbuecher: dict[str, ast.Dict] = {}

    for knoten in ast.walk(funktion):
        if not isinstance(knoten, ast.Assign):
            continue
        ziele = [z.id for z in knoten.targets if isinstance(z, ast.Name)]
        if isinstance(knoten.value, ast.Dict):
            for ziel in ziele:
                woerterbuecher[ziel] = knoten.value
        if name not in ziele:
            continue
        wert = knoten.value
        if isinstance(wert, ast.Call) and isinstance(wert.func, ast.Attribute):
            # `{...}.get(...)` oder `kodes.get(...)` — die Befunde stehen in den
            # Werten des Wörterbuchs, nicht am Zuweisungsziel. Beide Schreib-
            # weisen kommen im Bestand vor: `pruefe_tls` schreibt das Wörterbuch
            # direkt in den Aufruf.
            quelle = wert.func.value
            if isinstance(quelle, ast.Dict):
                treffer |= _strings(quelle)
            elif isinstance(quelle, ast.Name) and quelle.id in woerterbuecher:
                treffer |= _strings(woerterbuecher[quelle.id])
            treffer |= {s for a in wert.args for s in _strings(a)}
        else:
            treffer |= _strings(wert)
    return treffer


def _erzeugte_paare() -> set[tuple[str, str]]:
    """Jedes ``Schritt(<schritt>, False, <befund>)`` aus den Probe-Modulen.

    Nur die Fehlschläge — ein gelungener Schritt trägt keinen Befund, der
    erklärt werden müsste, und sein Satz kommt aus ``_GELUNGEN``.

    **Blinder Fleck, bewusst:** ``pruefe_tcp`` bekommt den Schrittnamen als
    Parameter (``tcp443`` bzw. ``rtmps`` erst beim Aufruf), seine Befunde
    tauchen hier deshalb nicht auf. Das ist tragbar, solange die Funktion
    genau einen Fehlschlag kennt; wer ihr einen zweiten gibt, muss den Text
    von Hand nachtragen. ``gesamt/zeitueberschreitung`` entsteht erst in der
    Route und fehlt aus demselben Grund.
    """
    paare: set[tuple[str, str]] = set()
    for datei in _QUELLEN:
        baum = ast.parse(_modul_pfad(datei).read_text(encoding="utf-8"))
        for funktion in ast.walk(baum):
            # `async def` ist ein eigener Knotentyp — die Probe-Funktionen sind
            # alle asynchron, ein Test nur auf FunctionDef fände nichts.
            if not isinstance(funktion, ast.FunctionDef | ast.AsyncFunctionDef):
                continue
            for knoten in ast.walk(funktion):
                if not (
                    isinstance(knoten, ast.Call)
                    and isinstance(knoten.func, ast.Name)
                    and knoten.func.id == "Schritt"
                    and len(knoten.args) >= 3
                ):
                    continue
                schritt, gelungen, befund = knoten.args[0], knoten.args[1], knoten.args[2]
                if not (isinstance(schritt, ast.Constant) and isinstance(schritt.value, str)):
                    continue
                if not (isinstance(gelungen, ast.Constant) and gelungen.value is False):
                    continue
                if isinstance(befund, ast.Constant) and isinstance(befund.value, str):
                    paare.add((schritt.value, befund.value))
                elif isinstance(befund, ast.Name):
                    for wert in _aufgeloest(befund.id, funktion):
                        paare.add((schritt.value, wert))
    return paare


def test_quellen_liefern_ueberhaupt_befunde() -> None:
    """Schutz vor einem Test, der nichts mehr prüft.

    Findet die Erkennung oben nichts (weil jemand ``Schritt`` umbenannt oder
    die Aufrufe umgebaut hat), liefe alles Weitere über eine leere Menge und
    wäre wortlos grün — genau die Sorte Test, die niemandem auffällt.
    """
    paare = _erzeugte_paare()
    assert len(paare) >= 20, f"nur {len(paare)} Befunde erkannt — Erkennung kaputt?"
    # Zwei, die es geben MUSS: der häufigste Proxy-Fehler und der teuerste.
    assert ("websocket", "kein_upgrade") in paare
    assert ("tls", "kein_handschlag") in paare


@pytest.mark.parametrize("sprache", dt.SPRACHEN)
def test_jeder_erzeugbare_befund_hat_beide_saetze(sprache: str) -> None:
    ohne: list[tuple[str, str]] = []
    for schritt, befund in sorted(_erzeugte_paare()):
        was_ist, was_tun = dt.erklaerung(schritt, befund, False, sprache)
        sammeltext = dt.erklaerung(schritt, "gibt-es-nicht", False, sprache)
        if (was_ist, was_tun) == sammeltext or not was_tun.strip():
            ohne.append((schritt, befund))
    assert not ohne, f"ohne eigenen Text ({sprache}): {ohne}"


@pytest.mark.parametrize("sprache", dt.SPRACHEN)
def test_katalog_ist_vollstaendig_ausgefuellt(sprache: str) -> None:
    """Kein Eintrag darf halb leer sein — ``was_tun`` ist das Kernstück."""
    for schritt, befund in dt.alle_paare():
        was_ist, was_tun = dt.erklaerung(schritt, befund, False, sprache)
        assert was_ist.strip(), f"{schritt}/{befund} ohne was_ist ({sprache})"
        assert was_tun.strip(), f"{schritt}/{befund} ohne was_tun ({sprache})"


@pytest.mark.parametrize("sprache", dt.SPRACHEN)
def test_jeder_schritt_hat_titel_und_erfolgssatz(sprache: str) -> None:
    for schritt in (*dt.SCHRITTE, "gesamt"):
        assert dt.titel(schritt, sprache).strip()
        was_ist, was_tun = dt.erklaerung(schritt, "ok", True, sprache)
        assert was_ist.strip(), f"{schritt} ohne Erfolgssatz ({sprache})"
        assert was_tun == "", "ein gelungener Schritt braucht keinen Handgriff"


def test_katalog_kennt_nur_echte_schritte() -> None:
    """Ein Tippfehler im Schrittnamen macht den Eintrag unerreichbar."""
    erlaubt = {*dt.SCHRITTE, "gesamt"}
    fremd = sorted({s for s, _ in dt.alle_paare()} - erlaubt)
    assert not fremd, f"Einträge für unbekannte Schritte: {fremd}"


def test_unbekannter_befund_faellt_auf_den_sammeltext() -> None:
    """Der Server darf neuer sein als der Installer, den jemand vor Monaten zog."""
    for sprache in dt.SPRACHEN:
        was_ist, was_tun = dt.erklaerung("tls", "ganz-neuer-befund", False, sprache)
        assert was_ist.strip() and was_tun.strip()


def test_websocket_server_ohne_cloud_zeigt_auf_den_container_nicht_auf_die_firewall() -> None:
    """4046 entsteht, weil ``chat-gateway`` (routes/ws.py) die JWKS seines
    EIGENEN ``auth-svc`` noch nicht laden konnte (``jwks_pinning.py``:
    ``jwks_ready`` bleibt ``False``, bis ``settings.auth_jwks_url`` einmal
    antwortet). Im Self-Host-Container zeigt ``AUTH_JWKS_URL`` auf
    ``http://127.0.0.1:8001/.well-known/jwks.json`` — den lokalen ``auth-svc``
    im selben Container
    (``infra/self-host/s6/etc/s6-overlay/scripts/07-render-env.sh``), NICHT
    auf howispulse.com. 4046 sagt also „der Dienst nebenan antwortet nicht",
    nicht „kein Internet". Der Text darf den Betreiber deshalb nicht auf seine
    ausgehende Firewall schicken — das wäre die Suche am falschen Ende.
    """
    for sprache in dt.SPRACHEN:
        was_ist, was_tun = dt.erklaerung("websocket", "server_ohne_cloud", False, sprache)
        text = f"{was_ist} {was_tun}".lower()
        assert "firewall" not in text, f"schickt den Betreiber auf die Firewall ({sprache}): {text}"
        assert "ausgehend" not in text and "outbound" not in text, (
            f"behauptet weiter eine ausgehende Verbindung sei das Problem ({sprache}): {text}"
        )
        assert "pulse-doctor" in was_tun, (
            f"kein Verweis auf den Blick von innen (pulse-doctor) ({sprache}): {was_tun}"
        )


def test_cors_kein_header_grenzt_auf_das_hinzufuegen_ein_nicht_auf_den_login() -> None:
    """Der CORS-Schritt (``selfhost_probe_dienst.py::pruefe_cors``) schickt ein
    Preflight mit fremder ``Origin`` — genau der Cross-Origin-Aufruf aus
    ``web/src/lib/api/server-info.ts::preCheckServer``, den ``joinByHost.ts``
    beim HINZUFÜGEN eines Servers von einer anderen Adresse aus macht. Ein
    normaler Login direkt auf der eigenen Adresse des Servers ist same-origin
    und braucht kein CORS. Der Text darf also nicht pauschal behaupten, ohne
    diese Freigabe scheitere „das Anmelden" — das verweist Leute mit einem
    anderen Login-Problem auf die falsche Fährte.
    """
    verboten = {"de": "scheitert das anmelden", "en": "signing in fails"}
    hinweis_auf_fremde_herkunft = {
        "de": ("andere", "fremde", "hinzufüg", "wechseln"),
        "en": ("different", "another", "adding", "add this server"),
    }
    for sprache in dt.SPRACHEN:
        was_ist, was_tun = dt.erklaerung("cors", "kein_header", False, sprache)
        text = f"{was_ist} {was_tun}"
        assert verboten[sprache] not in text.lower(), (
            f"pauschale Anmelde-Behauptung noch da ({sprache}): {text}"
        )
        assert any(w.lower() in text.lower() for w in hinweis_auf_fremde_herkunft[sprache]), (
            f"kein Hinweis auf die fremde Herkunft/das Hinzufügen ({sprache}): {text}"
        )


def test_sprachwahl() -> None:
    assert dt.sprache_aus_header("de") == "de"
    assert dt.sprache_aus_header("de-DE,de;q=0.9,en;q=0.8") == "de"
    assert dt.sprache_aus_header("en-US,en;q=0.9") == "en"
    assert dt.sprache_aus_header(None) == "en"
    assert dt.sprache_aus_header("") == "en"
    # „de" darf nicht in einem anderen Sprachnamen mitgelesen werden.
    assert dt.sprache_aus_header("nl-BE") == "en"


# ---------------------------------------------------------------------------
# Der Containername (III·2)
#
# install.sh unterstützt PULSE_CONTAINER und parametrisiert seine eigene
# pulse-doctor-Zeile damit korrekt — die Cloud-Texte taten das nicht: fünf
# Befehle (docker restart/exec/logs) nagelten den Namen "pulse" fest. Wer den
# Container umbenannt hat, bekam von der Cloud-Diagnose vier Befehle, die alle
# mit "No such container" scheitern.
# ---------------------------------------------------------------------------


def test_kein_text_nagelt_den_containernamen_fest():
    """Der Installer erlaubt PULSE_CONTAINER und parametrisiert seine eigene
    Zeile korrekt — die Cloud-Texte taten es nicht. Fuer jeden, der den Namen
    geaendert hat, scheitern vier Befehle mit "No such container".
    """
    import re

    treffer = []
    for schritt, befund in dt.alle_paare():
        for sprache in dt.SPRACHEN:
            for text in dt.erklaerung(schritt, befund, False, sprache):
                if re.search(r"docker \w+ pulse\b", text):
                    treffer.append((schritt, befund, sprache))
    assert not treffer, f"fester Containername in: {treffer}"


def test_container_wird_bei_angabe_eingesetzt() -> None:
    """Wird ein Name mitgegeben, taucht er auch im Text auf — sonst wäre die
    Parametrisierung aus dem vorigen Test nur Selbstzweck."""
    was_ist, was_tun = dt.erklaerung("tls", "abgelaufen", False, "de", container="mein-server")
    assert "docker restart mein-server" in was_tun
    assert "docker restart pulse" not in was_tun


def test_sammeltext_nagelt_ebenfalls_keinen_containernamen_fest() -> None:
    """``_ALLGEMEIN`` (der Sammeltext für unbekannte Befunde) steht nicht in
    ``_BEFUNDE`` und taucht deshalb in ``alle_paare()`` nicht auf — genau dort
    saß die fünfte im Audit gemessene Fundstelle (``docker logs pulse``),
    vom Test oben unentdeckt."""
    import re

    for sprache in dt.SPRACHEN:
        for text in dt.erklaerung("irgendein-schritt", "irgendein-befund", False, sprache):
            assert not re.search(r"docker \w+ pulse\b", text), text


@pytest.mark.parametrize(
    "roh",
    [
        "pulse; rm -rf /",
        "pulse && curl evil.example",
        "$(whoami)",
        "-pulse",
        "pulse\ndocker rm -f pulse",
        "pulse container",
        "",
        None,
    ],
)
def test_ungueltiger_containername_faellt_auf_pulse_zurueck(roh) -> None:
    """Der Name kommt von außen und landet in einem Befehl, den ein Mensch in
    seine Shell kopiert. Docker erlaubt für Containernamen nur
    ``[a-zA-Z0-9][a-zA-Z0-9_.-]*`` — alles andere UND ein fehlendes/leeres
    Feld (ältere Installer melden den Namen gar nicht) fallen auf "pulse"
    zurück, statt den rohen Text in den Handgriff zu übernehmen."""
    assert dt.container_name(roh) == "pulse"


@pytest.mark.parametrize("roh", ["pulse", "mein-server", "pulse_2", "a", "Server.1"])
def test_gueltiger_containername_bleibt_erhalten(roh: str) -> None:
    assert dt.container_name(roh) == roh


def test_eingebettetes_zeilenende_wird_nicht_durchgelassen() -> None:
    """``$`` passt in Python auch VOR einem abschließenden Zeilenende — mit
    ``.match()`` ließe "pulse\\n" den Anker unbemerkt passieren, und die
    Funktion gibt dabei ``roh`` UNVERÄNDERT zurück (nicht nur den
    getroffenen Teil), also mit dem Newline im Ergebnis. Die zweite
    Zusicherung ist die schärfere: fällt "mein-server\\n" auf die Vorgabe
    "pulse" zurück, ist das eindeutig eine Ablehnung — nicht zufällig
    dieselbe Zeichenkette wie ein abgeschnittener Treffer."""
    assert dt.container_name("pulse\n") == "pulse"
    assert dt.container_name("mein-server\n") == "pulse"
