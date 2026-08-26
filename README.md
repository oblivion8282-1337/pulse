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
| `services/`, `shared/`, `infra/` | **Pulse Server License 1.0** | Quelle einsehbar; Server-Betrieb über 32 Tage hinaus braucht eine kommerzielle Lizenz |
| `web/`, `desktop/`, `mobile/`, `streaming/`, `plugins/`, `packaging/` | **Pulse Client License 1.0** | Frei nutzbar, Quelle einsehbar; Ändern, Weitergeben und Wiederverwenden verboten |

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

`streaming/` enthält die Pulse-eigenen Rust-Sidecars fürs HQ-Screen-Streaming
(Aufnahme+Encode je Plattform) und den nativen Player. Sie linken gegen ein
gepinntes FFmpeg (LGPL, dynamisch gelinkt) — nicht Teil dieses Repositorys,
gebaut aus dem Upstream bzw. im Flatpak gebündelt, unter eigener Lizenz.

**Bis zum 2026-08-27** gehörte hierzu zusätzlich der **GPU Screen Recorder**
(GSR) als separater Subprozess-Sidecar unter Linux. Der Rust-Sidecar hat ihn
ersetzt; GSR ist kein Bestandteil mehr.
