"""cluster_disk_info: Garage-Pfad vs. MinIO-Rückfall + /v1/health-Parser.

Die Admin-Übersicht zeigt „X von Y GB": seit dem Garage-Umzug kommt die
Kapazität aus Garages Admin-API (/v1/health → storageTotal/storageFree),
nicht mehr aus MinIOs storageinfo. Beide Wege müssen schaltbar bleiben
(GARAGE_ADMIN_ENDPOINT leer = Alt-Deployment).
"""

import asyncio

from dcc_chat_gateway import s3


def test_parse_garage_health_ok():
    assert s3.parse_garage_health({"storageTotal": 10, "storageFree": 4}) == (10, 4)


def test_parse_garage_health_ohne_kapazitaet_ist_none():
    # Frisches Layout ohne zugewiesene Kapazität (storageTotal 0/fehlt) —
    # die UI zeigt dann „noch nicht aktiv", nicht 0 von 0 GB.
    assert s3.parse_garage_health({}) is None
    assert s3.parse_garage_health({"storageTotal": 0, "storageFree": 1}) is None
    assert s3.parse_garage_health({"storageTotal": None, "storageFree": None}) is None


def test_garage_pfad_wird_genommen_wenn_endpoint_gesetzt(monkeypatch):
    gelaufen = []

    async def fake_garage(s):
        gelaufen.append("garage")
        return (10, 5)

    async def fake_minio(s):
        gelaufen.append("minio")
        return (1, 1)

    monkeypatch.setattr(
        s3,
        "get_settings",
        lambda: type("S", (), {"garage_admin_endpoint": "http://garage:3909"}),
    )
    monkeypatch.setattr(s3, "_garage_disk_info", fake_garage)
    monkeypatch.setattr(s3, "_minio_disk_info", fake_minio)
    assert asyncio.run(s3.cluster_disk_info()) == (10, 5)
    assert gelaufen == ["garage"]


def test_ohne_endpoint_faellt_auf_minio_zurueck(monkeypatch):
    gelaufen = []

    async def fake_minio(s):
        gelaufen.append("minio")
        return None

    monkeypatch.setattr(
        s3,
        "get_settings",
        lambda: type("S", (), {"garage_admin_endpoint": ""}),
    )
    monkeypatch.setattr(s3, "_minio_disk_info", fake_minio)
    assert asyncio.run(s3.cluster_disk_info()) is None
    assert gelaufen == ["minio"]
