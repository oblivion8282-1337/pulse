"""cluster_disk_info: Garage-Pfad vs. MinIO-Rückfall + /v1/status-Parser.

Die Admin-Übersicht zeigt „X von Y GB": seit dem Garage-Umzug kommt die
Kapazität aus Garages Admin-API (/v1/status → nodes[].dataPartition —
echte Datenträger-Werte), nicht mehr aus MinIOs storageinfo. Beide Wege
müssen schaltbar bleiben (GARAGE_ADMIN_ENDPOINT leer = Alt-Deployment).
"""

import asyncio

from dcc_chat_gateway import s3


def test_parse_garage_status_single_node():
    data = {
        "nodes": [
            {"id": "n1", "dataPartition": {"total": 539792977920, "available": 496652492800}},
        ]
    }
    assert s3.parse_garage_status(data) == (539792977920, 496652492800)


def test_parse_garage_status_summiert_und_ignoriert_ohne_rolle():
    data = {
        "nodes": [
            {"id": "n1", "dataPartition": {"total": 100, "available": 60}},
            {"id": "n2"},  # ohne Daten-Rolle — kein dataPartition
            {"id": "n3", "dataPartition": {"total": 100, "available": 30}},
        ]
    }
    assert s3.parse_garage_status(data) == (200, 90)


def test_parse_garage_status_ohne_kapazitaet_ist_none():
    assert s3.parse_garage_status({}) is None
    assert s3.parse_garage_status({"nodes": [{"id": "n1"}]}) is None
    assert s3.parse_garage_status({"nodes": [{"dataPartition": {"total": 0}}]}) is None


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
