"""Tests für den Weckruf des Stream-Pollers (``weckruf.py``)."""

from __future__ import annotations

import time

import pytest
from dcc_media_svc import weckruf


@pytest.fixture(autouse=True)
def _ohne_ankuendigungen(monkeypatch):
    monkeypatch.setattr(weckruf, "_erwartet", {})


def test_wach_bis_genau_der_angekuendigte_stream_gesehen_wurde():
    assert not weckruf.ist_wach()
    weckruf.wecken("7", "42", 0)
    assert weckruf.ist_wach()
    # Ein anderer Platz desselben Nutzers ist nicht der angekündigte Stream.
    weckruf.gesehen([("7", "42", "1")])
    assert weckruf.ist_wach()
    weckruf.gesehen([("7", "42", "0")])
    assert not weckruf.ist_wach()


def test_ankuendigung_verfaellt_nach_der_frist():
    """Kommt der Stream nie (Abbruch im Bildschirm-Dialog, Sidecar-Fehler),
    darf die Ankündigung den Poller nicht für immer im Schnelltakt halten."""
    weckruf._erwartet[("7", "42", "0")] = time.monotonic() - 1
    assert not weckruf.ist_wach()
    assert weckruf._erwartet == {}
