"""pulse-livekit-node-ip (infra/self-host/livekit-node-ip.sh).

Setzt die öffentliche IPv4 als LiveKit-``node_ip`` statt STUN (Firefox im
selben Heimnetz bekam sonst nur die öffentliche Adresse, Linux-Test
2026-10-08). Geprüft wird das echte Skript gegen das echte Template: das
Ergebnis muss gültiges YAML mit genau den erwarteten RTC-Schaltern sein, und
ein zweiter Aufruf (IP-Wechsel) darf nichts doppeln.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest
import yaml

WURZEL = Path(__file__).resolve().parents[1]
SKRIPT = WURZEL / "livekit-node-ip.sh"
TEMPLATE = WURZEL / "templates" / "livekit.yaml.template"


def _lauf(datei: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["sh", str(SKRIPT), *args],
        env={**os.environ, "LIVEKIT_YAML": str(datei)},
        capture_output=True,
        text=True,
    )


@pytest.fixture
def yaml_datei(tmp_path: Path) -> Path:
    ziel = tmp_path / "livekit.yaml"
    ziel.write_text(
        TEMPLATE.read_text()
        .replace("@@LIVEKIT_KEY@@", "k")
        .replace("@@LIVEKIT_SECRET@@", "s")
        .replace("@@PULSE_HOSTNAME@@", "x.example.com")
    )
    return ziel


def test_setzt_node_ip_und_schaltet_stun_ab(yaml_datei: Path) -> None:
    r = _lauf(yaml_datei, "203.0.113.7")
    assert r.returncode == 0, r.stderr
    rtc = yaml.safe_load(yaml_datei.read_text())["rtc"]
    assert rtc["node_ip"] == "203.0.113.7"
    assert rtc["use_external_ip"] is False
    assert "skip_external_ip_validation" not in rtc
    # LAN-Adresse weiter ankündigen, IPv6 weiter gesperrt.
    assert rtc["advertise_internal_ip"] is True
    assert rtc["ips"]["excludes"] == ["::/0"]


def test_ip_wechsel_ersetzt_statt_zu_doppeln(yaml_datei: Path) -> None:
    assert _lauf(yaml_datei, "203.0.113.7").returncode == 0
    assert _lauf(yaml_datei, "198.51.100.9").returncode == 0
    text = yaml_datei.read_text()
    # Nur echte Schlüssel zählen — das Template erwähnt node_ip auch im Kommentar.
    assert [z for z in text.splitlines() if z.startswith("  node_ip: ")] == ["  node_ip: 198.51.100.9"]
    assert yaml.safe_load(text)["rtc"]["node_ip"] == "198.51.100.9"
    assert _lauf(yaml_datei, "--zeige").stdout.strip() == "198.51.100.9"


@pytest.mark.parametrize("wert", ["", "1.2.3", "1.2.3.4; rm -rf /", "::1", "1.2.3.4\nnode_ip: 9.9.9.9"])
def test_weist_alles_ausser_einer_nackten_ipv4_ab(yaml_datei: Path, wert: str) -> None:
    vorher = yaml_datei.read_text()
    r = _lauf(yaml_datei, wert)
    assert r.returncode == 2
    assert yaml_datei.read_text() == vorher


def test_zeige_ohne_node_ip_ist_leer(yaml_datei: Path) -> None:
    assert _lauf(yaml_datei, "--zeige").stdout.strip() == ""
