"""Ein Check für security.constant_time_eq: Nicht-ASCII wirft keinen TypeError
mehr (Bughunt 2026-09-16, Runde 2) und der Vergleich bleibt ablehnend."""

from dcc_auth.security import constant_time_eq


def test_nicht_ascii_kein_typeerror_sondern_ablehnung() -> None:
    # Vorher: hmac.compare_digest('pw-ü', 'ascii') -> TypeError -> HTTP 500.
    assert constant_time_eq("pw-ü", "pulse-ci-geheim") is False


def test_uebereinstimmung_und_leere_strings() -> None:
    assert constant_time_eq("ßekret", "ßekret") is True
    assert constant_time_eq("", "") is True
    assert constant_time_eq("a", "b") is False
