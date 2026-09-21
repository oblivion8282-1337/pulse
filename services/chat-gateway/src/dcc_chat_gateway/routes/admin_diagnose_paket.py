"""Self-Host-Diagnose-Paket (Spec 2026-09-21 §7, Phase 3).

Liefert das Paket, das der Betreiber per Knopf in die Pulse-Cloud schickt —
DER Server selbst ruft die Cloud nicht an; der Browser ist der Kurier
(`POST /me/instance-diagnose` im auth-svc, Owner-gegattert). Read-only,
AdminUser-Gate wie `admin_backups.py` (lokal validierter EdDSA-Session-Token,
Owner ⇒ admin-Claim).

**Was drin ist — und was ehrlicherweise nicht geht:**

* `setup_status` — die letzten 50 ROHZEILEN der Start-Checkliste (Format
  `<epoche>\t<name>\t<ok|fehler>`, so wie der Installer sie zeigt).
* `abstuerze` — die restart-gate-Zähler (`/var/run/pulse/restart-counter/`).
  **Zwei ehrliche Grenzen, im Feldnamen und hier dokumentiert:** (1) der
  Zähler läuft bei JEDEM Service-Exit, auch beim sauberen `docker stop`/
  Update-Neustart — die Zahl ist „Neustarts", nicht „Abstürze"; (2) `/var/run`
  ist tmpfs und überlebt einen Container-Neustart NICHT — ausgerechnet nach
  einer Crash-Serie mit erzwungenem Neustart ist das Feld leer; `kopf.
  uptime_s` entlarvt diesen Fall. Wer Absturz-Historie braucht: `docker logs`
  vom Host.
* `backups` — Zusammenfassung des pg_dump-Verzeichnisses (gleiche Quelle wie
  `/admin/self-host/backups`, hier nur verdichtet).
* `version` / `konfiguration` — `build_version()` + eine AUSSCHNITTSWEISE
  .getenv-Whitelist (hostname, tls_modus, http_port, instance_mode,
  cloud_origin, plus booleans für optionale Flags). **Niemals** `PULSE_CLOUD_
  CLIENT_ID/SECRET` oder andere Credentials — das Paket verlässt den Server.
* `cloud` — ein LIVE-Check der Cloud-Erreichbarkeit vom Server aus (3 s
  Timeout): genau die Richtung, die die Cloud-Diagnose NICHT misst.
* `bootstrap_logs` — die einzigen Datei-Logs im Container (pg-Bootstrap +
  Migrationen, gekappte Schwänze), **ZEILENREDIGIERT**: die pg-Logs können im
  Fehlerfall SQL-Statements samt Literalen loggen, und in
  `02-init-postgres.sh` steht darunter ein `ALTER ROLE … PASSWORD '<Klartext>'`
  — jede Zeile mit `password` wird darum ganz verworfen (Spec §8: hart,
  nicht best-effort).

**Nicht drin, und das ist eine Grenze der Plattform:** Laufzeit-Fehlerzeilen
der Dienste. Alle Longruns loggen ausschließlich nach stdout (`docker logs`)
— aus dem Container heraus gibt es dafür schlicht nichts auf Platte. Wer
diensteite Logs braucht, muss `docker logs` vom Host lesen; das Paket sagt
ihm über `abstuerze` + `setup_status` + `cloud` trotzdem, WO es hakt.
"""

from __future__ import annotations

import os
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter
from pydantic import BaseModel

from dcc_chat_gateway import __version__, build_version
from dcc_chat_gateway.routes.admin_backups import _backup_dir
from dcc_chat_gateway.security import AdminUser

router = APIRouter(prefix="/admin/self-host")

# Bootstrap-Datei-Logs: gekappte Schwänze, damit das Paket klein bleibt.
_LOG_TAIL_BYTES = 16 * 1024
_CLOUD_TIMEOUT_S = 3.0

# Ausdrückliche Whitelist — neue Envs kommen hier nur als bewusster Akt rein.
# Bewusst OHNE PULSE_DATA_PATH (Server-interner Dateisystempfad, für die
# Diagnose ohne Wert) und natürlich ohne alle Credential-Envs.
_KONFIG_KEYS = (
    "PULSE_HOSTNAME",
    "PULSE_TLS_MODE",
    "PULSE_HTTP_PORT",
    "PULSE_INSTANCE_MODE",
    "PULSE_CLOUD_ORIGIN",
)
_KONFIG_BOOLEANS = ("PULSE_TURN_DISABLED", "PULSE_BACKUP_DISABLED")


class DiagnosePaket(BaseModel):
    kopf: dict
    setup_status: list[str]
    abstuerze: dict[str, dict]
    backups: dict
    konfiguration: dict
    cloud: dict
    bootstrap_logs: dict[str, str]


def _lese_setup_status() -> list[str]:
    """Letzte ~50 Zeilen der Start-Checkliste (Format `<epoche>\\t<name>\\t<ok|fehler>`)."""
    pfad = Path(os.environ.get("PULSE_DATA_PATH", "/data")) / "setup-status"
    try:
        zeilen = pfad.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    return zeilen[-50:]


def _lese_abstuerze() -> dict[str, dict]:
    """restart-gate-Zähler: je Dienst die Neustart-Zeitstempel + Anzahl.
    Enthält saubere Stops (Update/Reboot) und ist tmpfs-flüchtig — siehe
    Modul-Docstring; das Feld ist „Neustarts", nicht „Abstürze".
    """
    verzeichnis = Path("/var/run/pulse/restart-counter")
    out: dict[str, dict] = {}
    try:
        dateien = list(verzeichnis.iterdir())
    except OSError:
        return out
    for datei in dateien:
        # restart-gate schreibt über <name>.tmp + mv — das Mikrosekunden-
        # Fenster soll nicht als eigener "Dienst" erscheinen.
        if datei.suffix == ".tmp":
            continue
        try:
            zeitstempel = sorted(
                int(z)
                for z in datei.read_text(encoding="utf-8").split()
                if z.strip()
            )
            letzer = (
                datetime.fromtimestamp(zeitstempel[-1], tz=timezone.utc).isoformat()
                if zeitstempel
                else None
            )
        except (OSError, ValueError, OverflowError):
            continue
        out[datei.name] = {"anzahl": len(zeitstempel), "letzer": letzer}
    return out


def _lese_backups() -> dict:
    verzeichnis = _backup_dir()
    if not verzeichnis.is_dir():
        return {"enabled": False, "anzahl": 0, "letzer": None, "total_bytes": 0}
    dateien = sorted(verzeichnis.glob("pulse-*.dump"), reverse=True)
    total = 0
    neuester: datetime | None = None
    for pfad in dateien:
        # TOCTOU-fest: der Backup-Service pruned täglich mitten in unserem Glob
        # (Muster aus admin_backups.py — eine verschwundene Datei lässt EINE
        # Zeile aus, nicht den ganzen Endpoint sterben).
        try:
            st = pfad.stat()
        except OSError:
            continue
        total += st.st_size
        if neuester is None:
            neuester = datetime.fromtimestamp(st.st_mtime, tz=timezone.utc)
    return {
        "enabled": True,
        "anzahl": len(dateien),
        "letzer": neuester.isoformat() if neuester else None,
        "total_bytes": total,
    }


def _lese_konfiguration() -> dict:
    out: dict = {k.split("PULSE_", 1)[1].lower(): os.environ.get(k) for k in _KONFIG_KEYS}
    for schluessel in _KONFIG_BOOLEANS:
        out[schluessel.split("PULSE_", 1)[1].lower()] = (
            os.environ.get(schluessel, "").lower() in ("1", "true", "yes")
        )
    return out


async def _pruefe_cloud() -> dict:
    origin = (os.environ.get("PULSE_CLOUD_ORIGIN") or "https://howispulse.com").rstrip("/")
    start = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=_CLOUD_TIMEOUT_S) as client:
            resp = await client.get(f"{origin}/api/chat/health")
    except Exception as e:  # noqa: BLE001 — der FEHLER ist das Ergebnis
        return {"ok": False, "origin": origin, "fehler": str(e)[:200]}
    return {
        "ok": resp.status_code == 200,
        "origin": origin,
        "http_status": resp.status_code,
        "ms": round((time.monotonic() - start) * 1000),
    }


def _redigiere_bootstrap_log(text: str) -> str:
    """Zeilen-Redaktion für die pg-Logs (Spec §8: hart, nicht best-effort).

    Postgres loggt bei ERROR standardmäßig das ganze STATEMENT samt Literal —
    und `02-init-postgres.sh` führt bei jedem Boot ein
    `ALTER ROLE pulse WITH PASSWORD '<Klartext-Geheimnis>'` aus. Schlägt das
    fehl (Disk voll), steht das DB-Passwort in pg-bootstrap.log, und ohne
    Redaktion würde der 16-KiB-Schwanz es in die Cloud tragen. Darum: JEDE
    Zeile mit `password` (unabhängig von Groß-/Kleinschreibung) fliegt raus —
    konservativ, denn ein Fehlverdacht kostet eine Logzeile, ein Leck kostet
    das Vertrauen.
    """
    return "\n".join(
        zeile for zeile in text.splitlines() if "password" not in zeile.lower()
    )


def _lese_bootstrap_logs() -> dict[str, str]:
    out: dict[str, str] = {}
    for name in ("pg-bootstrap.log", "pg-migrations.log"):
        pfad = Path("/var/log/pulse") / name
        try:
            with pfad.open("rb") as f:
                f.seek(0, 2)
                groesse = f.tell()
                f.seek(max(0, groesse - _LOG_TAIL_BYTES))
                roh = f.read().decode("utf-8", errors="replace")[-_LOG_TAIL_BYTES:]
        except OSError:
            continue
        out[name] = _redigiere_bootstrap_log(roh)
    return out


def _container_uptime_s() -> float | None:
    """Uptime über PID 1 (s6-Init): starttime (Feld 22, Ticks seit Boot) gegen
    `btime` aus /proc/stat. /proc/uptime wäre die HOST-Uptime, nicht die des
    Containers."""
    try:
        felder = Path("/proc/1/stat").read_text().rsplit(")", 1)[1].split()
        starttime_ticks = int(felder[19])  # Feld 22 gesamt; nach ")+"-Split Index 19
        for zeile in Path("/proc/stat").read_text().splitlines():
            if zeile.startswith("btime "):
                btime = int(zeile.split()[1])
                hz = os.sysconf("SC_CLK_TCK")
                return round(time.time() - btime - starttime_ticks / hz)
    except (OSError, ValueError, IndexError):
        pass
    return None


@router.get("/diagnose-paket", response_model=DiagnosePaket)
async def diagnose_paket(_actor: AdminUser) -> DiagnosePaket:
    settings_id = os.environ.get("PULSE_INSTANCE_ID", "0")
    return DiagnosePaket(
        kopf={
            "hostname": os.environ.get("PULSE_HOSTNAME", ""),
            "instance_id": settings_id,
            "server_version": __version__,
            "build_version": build_version(),
            "uptime_s": _container_uptime_s(),
            "erstellt": datetime.now(timezone.utc).isoformat(),
        },
        setup_status=_lese_setup_status(),
        abstuerze=_lese_abstuerze(),
        backups=_lese_backups(),
        konfiguration=_lese_konfiguration(),
        cloud=await _pruefe_cloud(),
        bootstrap_logs=_lese_bootstrap_logs(),
    )
