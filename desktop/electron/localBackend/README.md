# localBackend — Self-Host-Orchestrator (App-Hosting)

Startet den kompletten Pulse-Server auf dem Gerät des Nutzers als **EINEN allinone-Container**
über die Container-Runtime des Systems (Podman oder Docker).

**Hier stand bis 2026-08-08 die native Prozess-Orchestrierung** — sieben Prozesse via `uv run`,
Postgres über `initdb`/`pg_ctl`, ein Host-`frpc` als Tunnel-Sidecar, gesteuert von einem
`LocalBackendManager` in `localBackendManager.ts`/`process.ts`/`postgres.ts`/`tunnel.ts`.
**Das ist seit dem 02.07.2026 falsch**: Commit `081520f4` („feat(app-hosting): Ein-Knopf-Container
statt nativer Prozess-Orchestrierung") hat diese Module gelöscht. Das Image initialisiert Postgres,
Secrets und Migrationen selbst; `frpc` läuft darin mit. Wer den alten Stand braucht, findet ihn
unter `git show 081520f4^:desktop/electron/localBackend/<datei>`; die Umbau-Begründung steht in
`docs/plans/2026-07-02-apphost-container-handover.md`.

## Voraussetzungen

Auf dem Host wird **kein** Postgres, Redis, MinIO, `uv` oder `frpc` mehr gebraucht — nur eine
Container-Runtime. `containerRuntime.ts` sucht sie in dieser Reihenfolge:

1. Linux im Flatpak: Host-Podman via `flatpak-spawn --host` (braucht `--talk-name=org.freedesktop.Flatpak`)
2. mitgebündeltes Podman unter `resources/podman/` (Windows/macOS-Installer)
3. `podman` auf dem PATH
4. `docker` auf dem PATH

Fehlt alles, meldet die App den Zustand `local-host-no-runtime` mit Setup-Hinweis, statt zu scheitern.

## Ablauf von `start()`

`containerBackendManager.ts`: Runtime finden → Env-Datei rendern → Registry-Login mit den
Instanz-Creds (`--password-stdin`) → `pull` → Netzwerk-Modus wählen → alten Container ersetzen →
`run` → Health-Poll → Relays hochziehen. `stop()` stoppt den Container; das Volume bleibt.

| Konstante | Wert |
|---|---|
| Container | `pulse-host` |
| Volume | `pulse-host-data` |
| Image | `registry.howispulse.com/pulse-allinone:edge` |
| Host-Port (HTTP) | `55580` |

Nur die `PULSE_*`-Pairing-Werte gehen in die Env-Datei (0600); DB, Secrets und Keys erzeugt das
Image selbst in `/data`. **Secrets stehen nie in argv und nie im Log** — nur in der Env-Datei und
im `--password-stdin`-Login.

## Netzwerk — zwei Wege, und der Unterschied ist der Grund für die Relays

Der Netzwerk-Modus hängt an der Runtime, nicht am Wunsch:

**Linux / Docker** — klassisches Port-Publishing. HTTP auf `127.0.0.1:55580`, dazu die
Medien-Ports `3478/tcp+udp`, `7882-7892/udp`, `1936/tcp`, `8189/udp` und `7900/udp` direkt
gemappt (Voice und Streams gehen zum Gerät, nicht über den Relay). **Diese Liste muss mit
`portMapper.ts` synchron bleiben.** Health-Poll auf `127.0.0.1:55580`.

**Windows / macOS mit podman** — `--network host`, und der Container bindet auf der
podman-machine-VM statt auf dem Host. Grund: rootless podman leitet eingehendes **UDP** nicht
über published Ports in die VM (TCP schon) — Direktpfad und Voice bekämen nie ein Paket.
Health-Poll geht dann auf die VM-IP, Port 8080.

Die Lücke zwischen Host und VM schließen die beiden Relays dieses Branches, hochgezogen von
`ensureRelay()`:

- **`udpRelay.ts`** — pro Port ein Listener auf `0.0.0.0`, Datagramme an die VM. Der Rückweg ist
  NAT-artig: pro Peer ein Wegwerf-Socket, und die Antwort muss den **angekündigten** Port als
  Quelle tragen, sonst verwirft ICE sie.
- **`tcpRelay.ts`** — transparenter Byte-Durchreicher für die TCP-Medienpfade. Ohne ihn läuft der
  RTMPS-Ingest des Owners ins Leere: media-svc mintet ihm bewusst eine
  `rtmps://localhost:1936`-Push-URL, aber MediaMTX liegt in der VM.

## Auto-Port-Mapping

`portMapper.ts` implementiert die NAT-PMP-Orchestrierung (Best-Effort, kein Hard-Fail): ermittelt
die WAN-IP via `external-address`-Request, erkennt CGNAT (private/CGNAT-Subnetz oder WAN-IP ≠
STUN-IP) und mappt anschliessend alle `MEDIA_MAP_UDP`- und `MEDIA_MAP_TCP`-Ports 1:1.
Verdikt: `mapped` | `partial` | `cgnat` | `unsupported`. Integrationstests gegen einen lokalen
Fake-NAT-PMP-Server liegen in `test/localBackend/portMapper.int.test.ts`.

## Dev-Seams

| Variable | Wirkung |
|---|---|
| `PULSE_HOST_IMAGE=<lokales Image>` | überspringt Registry-Login + Pull (Dev-Instanz-Creds existieren im Prod-Registry-Realm nicht) |
| `PULSE_HOST_ASSUME_REACHABLE=1` | überspringt die Erreichbarkeits-Diagnose (die STUN/UDP-Probe hängt in geblockten Netzen) |

## Tests

Die Unit- und Integrationstests laufen mit dem regulären Desktop-Lauf:

```bash
cd desktop && pnpm test:unit
```

`reachability.int.test.ts` (UDP-Probe) schlägt umgebungsabhängig fehl, wenn ausgehendes UDP
geblockt ist — das ist kein Regress.

Der Tunnel-E2E-Test (frps + Server-Plugin + frpc → Request durch den Tunnel, plus Deny-Token,
Deny-Impersonation und Reconnect) lebt im Relay-Plugin-Paket:

```bash
cd services/relay-frps-plugin && uv run pytest tests/test_integration.py -v
```

Er überspringt sich automatisch, wenn `frps`/`frpc` nicht auf dem PATH sind (`brew install frpc frps`).
