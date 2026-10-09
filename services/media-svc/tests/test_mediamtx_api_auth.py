"""media-svc schickt die MediaMTX-API-Zugangsdaten nur, wenn ein Passwort
gesetzt ist (Self-Host-Container); sonst bleibt der Aufruf wie bisher."""

from __future__ import annotations

from dcc_media_svc.config import Settings


def test_ohne_passwort_keine_anmeldung():
    assert Settings().mediamtx_api_auth is None


def test_mit_passwort_basic_auth():
    s = Settings(mediamtx_api_password="geheim")
    assert s.mediamtx_api_auth == ("pulse-media-svc", "geheim")
