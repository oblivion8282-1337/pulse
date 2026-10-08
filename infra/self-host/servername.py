#!/opt/pulse/venv/bin/python3
"""pulse-servername — Server-Name lesen/setzen, für die Server-App.

    pulse-servername --zeige     aktuellen Namen ausgeben (leer = keiner)
    pulse-servername <name>      Namen setzen ("" = zurücksetzen)

Die Server-App hat auf ihrem eigenen Server kein Admin-Konto, kommt aber per
``podman exec`` in den Container. Dieses Werkzeug spricht von dort den
internen Weg des chat-gateway an (``/internal/instance-name``, Begründung in
services/chat-gateway/…/routes/internal_instance_name.py) — mit dem internen
Geheimnis, das nur im Container liegt. Der chat-gateway verteilt den Namen
dann an verbundene Clients und meldet ihn der Cloud.

Der Name kommt als argv (kein Shell-Weg) und geht als JSON — keine Quoting-
Frage. Ausgabe: der danach gespeicherte Name auf stdout.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

URL = "http://127.0.0.1:8002/internal/instance-name"
GEHEIMNIS = os.path.join(os.environ.get("PULSE_DATA_PATH", "/data"), "jwt_keys", "internal_service.token")


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print(__doc__.strip().splitlines()[2], file=sys.stderr)
        return 2
    with open(GEHEIMNIS, encoding="utf-8") as f:
        geheimnis = f.read().strip()
    kopf = {"X-Pulse-Internal-Secret": geheimnis, "Content-Type": "application/json"}
    if argv[0] == "--zeige":
        req = urllib.request.Request(URL, headers=kopf, method="GET")
    else:
        daten = json.dumps({"name": argv[0]}).encode()
        req = urllib.request.Request(URL, data=daten, headers=kopf, method="PUT")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            name = json.load(r).get("name")
    except urllib.error.HTTPError as e:
        print(f"[servername] HTTP {e.code}", file=sys.stderr)
        return 3
    except (urllib.error.URLError, OSError) as e:
        print(f"[servername] chat-gateway nicht erreichbar: {e}", file=sys.stderr)
        return 4
    print(name or "")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
