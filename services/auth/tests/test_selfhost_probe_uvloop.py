"""Die Prüfung muss unter der Ereignisschleife laufen, die in Produktion läuft.

Am 2026-08-25 hat ein Betreiber die Erreichbarkeitsprüfung zum ersten Mal echt
aufgerufen. Antwort: **HTTP 500**.

    routes_selfhost_diagnose.py:162  → pruefe_stun(adresse)
    selfhost_probe_dienst.py:274     → await schleife.sock_sendto(...)
    uvloop/loop.pyx:2647             → NotImplementedError

``uvloop`` implementiert ``sock_sendto`` nicht. uvicorn benutzt uvloop, sobald
es installiert ist — und ``uvicorn[standard]`` zieht es mit. Die Tests dagegen
liefen unter Pythons Standardschleife, wo ``sock_sendto`` existiert.

**2206 grüne Tests, und die Funktion stürzte beim ersten echten Aufruf ab.**

Dazu kam die schlechteste denkbare Fehlerform: die Kette bricht bei DNS- oder
Portfehlern früh ab und erreicht ``pruefe_stun`` gar nicht. Die Prüfung
„funktionierte" also genau dann, wenn der Server kaputt war, und stürzte ab,
sobald er erreichbar war.

Deshalb wird hier nicht mit ``pytest.mark.asyncio`` gearbeitet (das nähme die
Standardschleife und würde den Fehler wieder verstecken), sondern die Funktion
ausdrücklich mit ``uvloop.run`` gefahren.

``uvloop`` wird bewusst OHNE ``importorskip`` importiert: fehlt es, weicht die
Testumgebung von der Produktion ab, und genau das soll auffallen — laut, nicht
als übersprungener Test.
"""

from __future__ import annotations

import asyncio
import inspect

import uvloop

from dcc_auth import selfhost_probe, selfhost_probe_dienst as dienst

#: RFC 5737 TEST-NET-3 — garantiert nicht geroutet, antwortet nie. Der Aufruf
#: endet entweder sofort mit OSError (keine Route) oder in der Frist; beides
#: muss als sauberer Befund herauskommen, nicht als Ausnahme.
_TOTE_ADRESSE = "203.0.113.1"


def test_stun_pruefung_ueberlebt_uvloop(monkeypatch):
    """Der eigentliche Regressionstest: kein NotImplementedError unter uvloop."""
    monkeypatch.setattr(dienst, "FRIST_S", 0.3)
    schritt = uvloop.run(dienst.pruefe_stun(_TOTE_ADRESSE))
    assert schritt.schritt == "stun"
    assert schritt.befund == "kein_durchkommen"


def test_stun_pruefung_verhaelt_sich_auf_beiden_schleifen_gleich(monkeypatch):
    """Gegenprobe — sonst prüfte der Test oben nur „irgendetwas kommt zurück".

    Beide Schleifen müssen denselben Befund liefern. Liefe die eine in einen
    anderen Zweig, wäre die Aussage der Prüfung von der Laufzeitumgebung
    abhängig, und genau das ist der Fehler, um den es hier geht.
    """
    monkeypatch.setattr(dienst, "FRIST_S", 0.3)
    unter_uvloop = uvloop.run(dienst.pruefe_stun(_TOTE_ADRESSE))
    unter_standard = asyncio.run(dienst.pruefe_stun(_TOTE_ADRESSE))
    assert (unter_uvloop.schritt, unter_uvloop.befund) == (
        unter_standard.schritt,
        unter_standard.befund,
    )


def test_keine_von_uvloop_unbekannten_schleifen_aufrufe():
    """Die Fehlerklasse, nicht nur dieser eine Fall.

    ``uvloop`` implementiert einen Teil der ``loop.sock_*``-Familie nicht.
    Wer hier eine dieser Methoden benutzt, baut denselben Fehler neu — und
    merkt es wieder erst in Produktion, weil die Tests woanders laufen.
    Geprüft wird der Quelltext, nicht das Verhalten: ein Aufruf in einem
    selten begangenen Zweig würde sonst durchrutschen.
    """
    verboten = ("sock_sendto", "sock_recvfrom", "sock_recvfrom_into")
    treffer = []
    for modul in (selfhost_probe, dienst):
        quelle = inspect.getsource(modul)
        for name in verboten:
            if f".{name}(" in quelle:
                treffer.append(f"{modul.__name__}: {name}")
    assert not treffer, (
        f"uvloop kennt diese Methoden nicht: {treffer}. "
        "UDP gehört über loop.create_datagram_endpoint()."
    )
