# localBackend — Self-Host aus der Desktop-App

> **AUF EIS (Stand 2026-08-11).** Self-Hosting läuft vorerst ausschliesslich über
> einen eigenen Server (Container-Stack, s. `IDENTITY_CONCEPT.md` und
> `infra/prod/DEPLOY.md`) — dieser Weg ist in Betrieb und bewährt. Der hier
> beschriebene Weg, bei dem die **Desktop-App selbst** den Stack auf dem
> Rechner des Nutzers hochfährt, wird derzeit nicht weiterverfolgt. Der Code
> bleibt liegen, er wird nicht entfernt — nur nicht gepflegt.

Orchestriert den Pulse-Server als **einen All-in-one-Container** — seit dem
2026-07-02 in `containerBackendManager.ts`; die frühere native
Prozess-Orchestrierung (einzelne Postgres/Redis/MinIO/frpc-Binaries,
`tunnel.ts`, `LocalBackendManager`) ist damit ersetzt und gelöscht. Das Image
initialisiert Postgres, Secrets und Migrationen selbst; `frpc` für den
Relay-Tunnel läuft im Image — der serverseitige Auth-Hook lebt in
`services/relay-frps-plugin`.

## Ablauf

`ContainerBackendManager.start()` (in `main.ts` mit `hostLifecycle.ts`
verdrahtet): Runtime finden → Env-Datei rendern (nur die PULSE_*-Pairing-Werte,
0600) → Registry-Login (Instanz-Creds) → Pull → alten Container ersetzen → Run
→ Health-Poll. `stop()` stoppt den Container; das `/data`-Volume
(`pulse-host-data`) bleibt. Default-Image:
`registry.howispulse.com/pulse-allinone:edge` (Dev/Test-Override:
`PULSE_HOST_IMAGE` — entfällt Registry-Login + Pull).

Die Runtime-Suche steckt in `containerRuntime.ts`: Flatpak-Host-Podman via
`flatpak-spawn --host` → Podman im PATH → Docker im PATH. (Die frühere
Bündelung eigener Podman-Binaries für Win/Mac ist seit 2026-07-14 geparkt.)

## Module

| Modul | Zweck |
|---|---|
| `pairing.ts` | Cloud-Bootstrap-Token einlösen (`POST /api/auth/selfhost/bootstrap`), Creds mappen, Store-I/O |
| `gateway.ts` | Default-Gateway-Discovery für NAT-PMP/PCP (UDP 5351) |
| `portMapper.ts` | NAT-PMP-Orchestrierung (Best-Effort, kein Hard-Fail); Verdikt: `mapped` \| `partial` \| `cgnat` \| `unsupported` |
| `reachability.ts` | Erreichbarkeits-Check gegen die Cloud-Probe |
| `netdiag.ts` / `netbefund.ts` | Netzdiagnose: Kette Namensauflösung → TCP → TLS → HTTP einzeln abgehen, TLS-Befund deuten |
| `health.ts` | Health-Probe-Bausteine (HTTP-200-Check) |
| `dataTools.ts` | „Deine Daten“: belegte Größe des Data-Volumes + Export |

## Tests

- **Unit** (laufen im `test:unit`-Standardlauf, fassen kein Netz an):
  `containerBackend`, `dataTools`, `gateway`, `natpmp`, `pairing`,
  `netbefund`, `reachability`, `stun`. Daneben liegt `netdiag.test.ts` —
  es ist (noch) nicht in `test:unit` eingetragen.
- **Integration** (`pnpm test:localbackend-int`, nur auf Zuruf):
  `portMapper.int.test.ts` und `reachability.int.test.ts` binden ihre
  Fake-Server auf Port 0 an `127.0.0.1` und kollidieren daher mit keinem
  laufenden Medien-Stack — die früheren echten Ports (7882/8189/7881/1936)
  sind mit den gelöschten `media.int`/`manager.int`-Tests entfallen.
