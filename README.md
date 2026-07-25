# Pulse

Web-First Chat + Voice + HQ-Screen-Streaming — Discord-artig, selbst-hostbar.

Monorepo: FastAPI-Services (`services/`), SvelteKit-Web (`web/`), Electron-Desktop
(`desktop/`), Streaming-Sidecars (`streaming/`). Architektur, Setup und History:
`PLAN.md`, `CLAUDE.md`, `infra/prod/DEPLOY.md`, `streaming/README.md`.

## Lizenz

Copyright (C) 2026 Oblivion Pictures — Michael de Meyer

Pulse ist **source-available, nicht Open Source**. Der Quellcode ist
veröffentlicht, damit ihn jeder lesen, prüfen und verändern kann — die Nutzung
ist aber eingeschränkt. Je nach Repository-Bereich gelten zwei Lizenzen:

| Bereich | Lizenz | |
|---|---|---|
| `services/`, `shared/`, `infra/` | **PolyForm Free Trial 1.0.0** | Server-Betrieb über 32 Tage hinaus braucht eine kommerzielle Lizenz |
| `web/`, `desktop/`, `mobile/`, `streaming/`, `plugins/`, `packaging/` | **PolyForm Perimeter 1.0.0** | Frei nutzbar und weitergebbar; verboten ist nur ein Konkurrenzprodukt |

**Pulse zu benutzen kostet nichts.** Wer sich per Web-, Desktop- oder Mobile-App
mit einem Pulse-Server verbindet — auch mit howispulse.com — braucht keine
Lizenz. Kostenpflichtig ist ausschließlich das **Selbst-Betreiben eines
Servers**; Self-Hosting wird freigeschaltet und als Dienst mit laufenden Updates
angeboten.

Vollständige Aufteilung inklusive Drittkomponenten: [`LICENSE`](LICENSE).
Lizenztexte: [`LICENSE-SERVER.md`](LICENSE-SERVER.md) ·
[`LICENSE-CLIENT.md`](LICENSE-CLIENT.md).

Die Veröffentlichung erfolgt **ohne jede Gewährleistung** — sogar ohne die
implizite Gewährleistung der Marktreife oder der Eignung für einen bestimmten
Zweck.

Versionen, die vor dem 25.07.2026 veröffentlicht wurden, standen unter der **GNU
Affero General Public License v3.0** und bleiben unter diesen Bedingungen
verfügbar.

### Beiträge

Beiträge erfordern einen Contributor License Agreement (CLA, Lizenz-Grant nach
Apache-ICLA-Vorbild). Der CLA räumt dem Copyright-Halter das Recht ein, das
Projekt inklusive der Beiträge unter mehreren Lizenzen anzubieten — darunter die
obigen source-available-Lizenzen und separate kommerzielle Lizenzen.

### Drittsoftware

`streaming/` enthält das Pulse-eigene Tooling rund um den **GPU Screen Recorder**
(GSR). Der GSR selbst ist **nicht** Teil dieses Repositorys — er wird zur
Laufzeit aus dem Upstream gebaut (`streaming/bootstrap-gsr.fish`) bzw. im
Flatpak gebündelt und steht unter seiner eigenen Lizenz. GSR läuft als separater
Subprozess-Sidecar (kein Linking).
