"""IP-Formen-Sperre der Ablage-SSRF-Prüfung (Bughunt 2026-09-23).

Der alte Netzlisten-Vergleich ließ IPv4-in-IPv6-Formen durch —
``IPv6Address in IPv4Network`` ist in Python immer ``False`` — und
``http://[::ffff:169.254.169.254]/`` ging als "öffentlich" durch, obwohl der
Kernel es als IPv4 verbindet und der Antwortkörper an den Nutzer zurückgeht.
Reiner Unit-Test: ``ist_privat`` ist die Gate-Funktion aller Ablage-Fetches
(``pruefe_ziel_oeffentlich``), die Routen-Tests decken den Rest.
"""

from dcc_chat_gateway.ablage_ssrf import ist_privat


def test_eingebettete_ipv4_formen_werden_gescheckt():
    # IPv4-mapped, 6to4, NAT64 — jeweils mit privatem eingebettetem v4
    assert ist_privat("::ffff:169.254.169.254")  # Cloud-Metadata via mapped
    assert ist_privat("::ffff:10.0.0.5")
    assert ist_privat("2002:a9fe:a9fe::")  # 6to4 von 169.254.169.254
    assert ist_privat("2002:c0a8:1::")  # 6to4 von 192.168.0.1
    assert ist_privat("64:ff9b::a9fe:a9fe")  # NAT64 Well-Known-Prefix
    assert ist_privat("64:ff9b:1::c0a8:1")  # NAT64 Local-Use
    # die klassischen Fälle bleiben zu
    assert ist_privat("169.254.169.254")
    assert ist_privat("10.0.0.5")
    assert ist_privat("::1")
    assert ist_privat("fe80::1")
    assert ist_privat("fc00::1")
    assert ist_privat("keine-ip")  # unparsbar -> fail closed


def test_oeffentliche_adressen_bleiben_erlaubt():
    assert not ist_privat("8.8.8.8")
    assert not ist_privat("::ffff:8.8.8.8")  # mapped auf öffentliches v4
    assert not ist_privat("2002:0808:0808::")  # 6to4 von 8.8.8.8
    assert not ist_privat("2606:4700:4700::1111")
