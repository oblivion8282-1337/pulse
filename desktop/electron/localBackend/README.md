# localBackend — Self-Host-Orchestrator

Orchestriert den vollständigen lokalen Self-Host-Stack (Postgres, Redis, MinIO, auth-svc, media-svc,
mediamtx-auth-hook, chat-gateway) sowie optional einen rathole-Client-Tunnel zum Cloud-Relay.

## Voraussetzungen (Binaries)

| Binary | Zweck | Bezugsquelle |
|---|---|---|
| `initdb`, `pg_ctl`, `postgres`, `psql` | PostgreSQL 15 | `brew install postgresql@15` |
| `redis-server` | Redis | `brew install redis` |
| `minio` | MinIO Object Storage | `brew install minio` |
| `uv` | Python-Toolchain | <https://docs.astral.sh/uv/> |
| `rathole` | Reverse-Tunnel-Client | `brew install rathole` (oder Binary von <https://github.com/rapiz1/rathole/releases>) |

`rathole` 0.5.0 ist getestet. Der Tunnel-Test benötigt `rathole` auf dem PATH.

## Integrationstests

### Stack-Test (ohne Tunnel)

```bash
cd desktop && \
PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH" \
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  --test --test-timeout=120000 \
  test/localBackend/manager.int.test.ts
```

### Tunnel-Test (rathole-Roundtrip)

Testet, dass ein HTTP-Request `chat-gateway /health` durch einen lokalen rathole-Tunnel (Server +
Client) erreichbar ist, und dass der `SupervisedProcess`-Reconnect funktioniert.

```bash
cd desktop && \
PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH" \
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  --test --test-timeout=120000 \
  test/localBackend/tunnel.int.test.ts
```

Der Test überspringt sich automatisch, wenn `rathole`, `initdb`, `redis-server`, `minio` oder `uv`
nicht gefunden werden.
