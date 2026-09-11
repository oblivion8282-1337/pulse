"""Reine Prüfungen der Namensfaltung (``validate_name``).

Der Rest dieser Datei (Upload-/Download-Rennen des alten Dropbox-
Speicherwegs) ist mit der Einstellung des Wegs am 2026-09-11 entfallen —
die Sicherheitszusage der Namensfaltung gilt für den Kanal-Anlege-Endpoint
weiter und bleibt hier als reiner Funktionstest erhalten.
"""

import pytest

from dcc_chat_gateway.routes._dropbox_helpers import validate_name

# ─── Befund 2: Namensfaltung vor der Prüfung ────────────────────────────────


@pytest.mark.parametrize(
    "raw",
    [
        "\uff0e\uff0e",  # FULLWIDTH FULL STOP  → ".."
        "\u2024\u2024",  # ONE DOT LEADER       → ".."
        "\uff0e\uff0e\uff0fevil.txt",  # → "../evil.txt"
        "a\uff0fb",  # FULLWIDTH SOLIDUS → echter Schrägstrich
        "\u3000name",  # IDEOGRAPHIC SPACE → führendes Leerzeichen
        ".\u200b.",  # Zero-Width dazwischen → ".."
        "boot\r\n.txt",  # Steuerzeichen
    ],
)
def test_validate_name_prueft_die_gespeicherte_form(raw: str):
    """Sicherheitszusage: kein Eingabename darf zu einem gespeicherten Namen
    werden, der ``..`` ist, einen echten Schrägstrich trägt oder Steuerzeichen
    enthält.

    Der alte Code normalisierte erst den Rückgabewert; alle sieben Fälle hier
    kamen deshalb an den Prüfungen vorbei und wurden in ihrer gefährlichen
    Form gespeichert — und von ``dropbox_downloads.py`` wörtlich als
    ZIP-Eintragsname geschrieben."""

    with pytest.raises(ValueError):
        validate_name(raw)


def test_validate_name_laesst_harmlose_namen_durch():
    """Gegenprobe: die Faltung darf gewöhnliche Namen nicht wegwerfen."""

    assert validate_name("Urlaub 2026.txt") == "Urlaub 2026.txt"
    assert validate_name(".env") == ".env"
    assert validate_name("東京.png") == "東京.png"
    # NFKC faltet Kompatibilitätszeichen — das ist gewollt und war schon vorher so.
    assert validate_name("\uff41\uff42") == "ab"


def test_validate_name_ist_idempotent():
    """Der Rückgabewert muss die Prüfung ein zweites Mal bestehen — sonst
    stünde derselbe Name in zwei Schreibweisen vor dem Unique-Index."""

    for raw in ("Urlaub 2026.txt", ".env", "\uff41\uff42", "e\u200d\u0301"):
        once = validate_name(raw)
        assert validate_name(once) == once
