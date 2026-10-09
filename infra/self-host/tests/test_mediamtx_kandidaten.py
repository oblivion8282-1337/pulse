"""MediaMTX-Zusatzkandidaten des App-Hosts (08-init-mediamtx.sh).

Unter Linux mit Docker-Bridge trägt das Container-Interface nur 172.17.x und
STUN liefert die WAN-Adresse — ein zweites Gerät im WLAN bekam ohne Hairpin am
Router keinen WHEP-Stream. Die Host-LAN-IPs aus ``PULSE_DIRECT_EXTRA_HOST_IPS``
müssen deshalb als ``webrtcAdditionalHosts`` erscheinen, zusammen mit der
VM-Ankündigung, nur IPv4, ohne Doppel. Geprüft wird die herausgeschnittene
Funktion unter ``sh`` (im Container ist das dash), und die Zeile muss als YAML
genau die erwartete Liste ergeben.
"""

from __future__ import annotations

import subprocess

import pytest
import yaml

SKRIPT = "etc/s6-overlay/scripts/08-init-mediamtx.sh"


@pytest.fixture
def zeile(skript_funktion):
    quelle = skript_funktion(SKRIPT, "zusatz_kandidaten_zeile")

    def lauf(vm: str, extra: str, eigene: str = "") -> str:
        r = subprocess.run(
            ["sh", "-c", f'set -eu\n{quelle}\nzusatz_kandidaten_zeile "$1" "$2" "$3"', "x", vm, extra, eigene],
            capture_output=True,
            text=True,
        )
        assert r.returncode == 0, r.stderr
        return r.stdout

    return lauf


def _hosts(ausgabe: str) -> list[str] | None:
    if not ausgabe:
        return None
    dok = yaml.safe_load(ausgabe)
    assert list(dok) == ["webrtcAdditionalHosts"]
    return dok["webrtcAdditionalHosts"]


def test_ohne_env_keine_zeile(zeile):
    assert zeile("", "") == ""


def test_docker_bridge_kuendigt_host_lan_ips_an(zeile):
    assert _hosts(zeile("", "192.168.178.87,10.0.0.5", "172.17.0.2")) == [
        "192.168.178.87",
        "10.0.0.5",
    ]


def test_echtes_lan_im_172er_bereich_kommt_durch(zeile):
    assert _hosts(zeile("", "172.20.1.9", "172.17.0.2")) == ["172.20.1.9"]


def test_vm_ankuendigung_und_lan_ips_zusammengefuehrt_ohne_doppel(zeile):
    assert _hosts(zeile("192.168.178.87", "192.168.178.87,100.64.0.3", "172.28.1.4")) == [
        "192.168.178.87",
        "100.64.0.3",
    ]


def test_nur_vm_ankuendigung_wie_bisher(zeile):
    assert _hosts(zeile("192.168.1.20", "")) == ["192.168.1.20"]


def test_pasta_sieht_lan_ip_selbst_kein_doppel(zeile):
    eigene = "192.168.178.87 fd37:47e:be16:0:6019:fd65:ffcc:3e52 2a02:2455:17dc:1100::1"
    assert zeile("", "192.168.178.87", eigene) == ""


def test_nur_ipv4_und_kaputtes_faellt_heraus(zeile):
    extra = "fe80::1,fd00::5,192.168.2.3,,1..2.3,1.2.3,1.2.3.4.5,.1.2.3,host.example"
    assert _hosts(zeile("", extra)) == ["192.168.2.3"]
