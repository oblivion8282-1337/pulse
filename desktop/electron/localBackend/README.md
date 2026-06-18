# localBackend — Self-Host-Orchestrator

Orchestriert den vollständigen lokalen Self-Host-Stack (Postgres, Redis, MinIO, auth-svc, media-svc,
mediamtx-auth-hook, chat-gateway) sowie optional einen frpc-Client-Tunnel zum Cloud-Relay.

## Voraussetzungen (Binaries)

| Binary | Zweck | Bezugsquelle |
|---|---|---|
| `initdb`, `pg_ctl`, `postgres`, `psql` | PostgreSQL 15 | `brew install postgresql@15` |
| `redis-server` | Redis | `brew install redis` |
| `minio` | MinIO Object Storage | `brew install minio` |
| `uv` | Python-Toolchain | <https://docs.astral.sh/uv/> |
| `frpc` | Reverse-Tunnel-Client (zum Cloud-Relay) | `brew install frpc` |

`frpc` 0.69 ist getestet. Der frpc-Client wird via `relay`-Konfig in `LocalBackendManager.start()`
nach dem chat-gateway gestartet (siehe `tunnel.ts`); der serverseitige Auth-Hook lebt in
`services/relay-frps-plugin`.

## Auto-Port-Mapping

`portMapper.ts` implementiert die NAT-PMP-Orchestrierung (Best-Effort, kein Hard-Fail): ermittelt
die WAN-IP via `external-address`-Request, erkennt CGNAT (private/CGNAT-Subnetz oder WAN-IP ≠
STUN-IP) und mappt anschliessend alle `MEDIA_MAP_UDP`- und `MEDIA_MAP_TCP`-Ports 1:1.
Verdikt: `mapped` | `partial` | `cgnat` | `unsupported`. Integrationstests gegen einen lokalen
Fake-NAT-PMP-Server liegen in `test/localBackend/portMapper.int.test.ts`.

## Integrationstests

### Medien-Dienste (LiveKit + MediaMTX)

Voraussetzung: `brew install livekit mediamtx` (sowie `openssl`, das auf macOS standardmassig verfügbar ist).

```bash
cd desktop && \
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  --test --test-timeout=60000 \
  test/localBackend/media.int.test.ts
```

Der Test überspringt sich automatisch, wenn `livekit-server`, `mediamtx` oder `openssl` nicht auf dem PATH sind.
Die Ports 7880 (LiveKit) und 9997 (MediaMTX) sind fest; wenn dort bereits ein Prozess läuft, schlägt der Test laut fehl.

### Stack-Test (ohne Tunnel)

```bash
cd desktop && \
PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH" \
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  --test --test-timeout=120000 \
  test/localBackend/manager.int.test.ts
```

### Tunnel-End-to-End-Test (frp-Auth-Hook)

Der Tunnel-E2E-Test (frps + Server-Plugin + frpc → Request durch den Tunnel, plus Deny-Token,
Deny-Impersonation und Reconnect) lebt jetzt im Relay-Plugin-Paket:

```bash
cd services/relay-frps-plugin && uv run pytest tests/test_integration.py -v
```

Der Test überspringt sich automatisch, wenn `frps`/`frpc` nicht auf dem PATH sind
(`brew install frpc frps`).
