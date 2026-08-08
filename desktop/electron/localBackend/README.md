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
Instanz-Creds (`--password-stdin`) → `pull` → alten Container ersetzen → `run` → Health-Poll auf
`127.0.0.1:55580/api/chat/health`. `stop()` stoppt den Container; das Volume bleibt.

| Konstante | Wert |
|---|---|
| Container | `pulse-host` |
| Volume | `pulse-host-data` |
| Image | `registry.howispulse.com/pulse-allinone:edge` |
| Host-Port (HTTP, nur 127.0.0.1) | `55580` |

Nur die `PULSE_*`-Pairing-Werte gehen in die Env-Datei (0600); DB, Secrets und Keys erzeugt das
Image selbst in `/data`. **Secrets stehen nie in argv und nie im Log** — nur in der Env-Datei und
im `--password-stdin`-Login.

Die Medien-Ports (`3478/tcp+udp`, `7882-7892/udp`, `1936/tcp`, `8189/udp`, `7900/udp`) werden direkt
gemappt, weil Voice und Streams zum Gerät gehen statt über den Relay. **Sie müssen mit
`portMapper.ts` synchron bleiben.**

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
