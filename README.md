# Pulse

Web-First Chat + Voice + HQ-Screen-Streaming — Discord-artig, selbst-hostbar.

Monorepo: FastAPI-Services (`services/`), SvelteKit-Web (`web/`), Electron-Desktop
(`desktop/`), Streaming-Sidecars (`streaming/`). Architektur, Setup und History:
`PLAN.md`, `CLAUDE.md`, `infra/prod/DEPLOY.md`, `streaming/README.md`.

## Lizenz

Copyright (C) 2026 Oblivion Pictures — Michael de Meyer

Pulse ist freie Software: Du kannst es unter den Bedingungen der **GNU Affero
General Public License**, Version 3 (**AGPL-3.0-only**), weitergeben und/oder
verändern — veröffentlicht von der Free Software Foundation. Den vollständigen
Lizenztext findest du in [`LICENSE`](LICENSE). Wer Pulse betreibt — auch als
Web-Dienst — muss den Nutzern den Quellcode anbieten (AGPL §13).

Die Veröffentlichung erfolgt in der Hoffnung, dass sie nützlich ist, jedoch
**ohne jede Gewährleistung** — sogar ohne die implizite Gewährleistung der
Marktreife oder der Eignung für einen bestimmten Zweck. Siehe die GNU Affero
General Public License für Details.

Ausgenommen sind die **Marken-Assets** unter [`Logo/`](Logo) (alle Rechte
vorbehalten) sowie die Drittkomponenten, die ihre eigenen Lizenzen behalten
(Übersicht: [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)).

Lizenz-Historie: bis 24.07.2026 AGPL-3.0 · 25.07.–28.07.2026 PolyForm ·
29.07.2026–01.10.2026 Pulse Client/Server License 1.0 (source-available) ·
seit 02.10.2026 wieder AGPL-3.0. Bereits veröffentlichte Versionen bleiben
unter der jeweils veröffentlichten Lizenz verfügbar.

### Beiträge

Beiträge erfordern einen Contributor License Agreement (CLA, Lizenz-Grant nach
Apache-ICLA-Vorbild). Pulse bleibt für alle unter der AGPL verfügbar; der CLA
ermöglicht dem Copyright-Halter zusätzlich eine optionale kommerzielle
Lizenzierung.

### Drittsoftware

`streaming/` enthält die Pulse-eigenen Rust-Sidecars fürs HQ-Screen-Streaming
(Aufnahme+Encode je Plattform) und den nativen Player. Sie linken gegen ein
gepinntes FFmpeg (LGPL, dynamisch gelinkt) — nicht Teil dieses Repositorys,
gebaut aus dem Upstream bzw. im Flatpak gebündelt, unter eigener Lizenz.

**Bis zum 2026-08-27** gehörte hierzu zusätzlich der **GPU Screen Recorder**
(GSR) als separater Subprozess-Sidecar unter Linux. Der Rust-Sidecar hat ihn
ersetzt; GSR ist kein Bestandteil mehr.
