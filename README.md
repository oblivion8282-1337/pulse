# Pulse

Web-First Chat + Voice + HQ-Screen-Streaming — Discord-artig, selbst-hostbar.

Monorepo: FastAPI-Services (`services/`), SvelteKit-Web (`web/`), Electron-Desktop
(`desktop/`), Streaming-Sidecars (`streaming/`). Architektur, Setup und History:
`PLAN.md`, `CLAUDE.md`, `infra/prod/DEPLOY.md`, `streaming/README.md`.

## Lizenz

Copyright (C) 2026 Oblivion Pictures — Michael de Meyer

Pulse ist freie Software: Du kannst es unter den Bedingungen der **GNU Affero
General Public License**, Version 3 oder (nach deiner Wahl) einer späteren
Version, weitergeben und/oder verändern — veröffentlicht von der Free Software
Foundation. Den vollständigen Lizenztext findest du in [`LICENSE`](LICENSE).

Die Veröffentlichung erfolgt in der Hoffnung, dass sie nützlich ist, jedoch
**ohne jede Gewährleistung** — sogar ohne die implizite Gewährleistung der
Marktreife oder der Eignung für einen bestimmten Zweck. Siehe die GNU Affero
General Public License für Details.

### Beiträge

Beiträge erfordern einen Contributor License Agreement (CLA, Lizenz-Grant nach
Apache-ICLA-Vorbild). Pulse bleibt für alle unter der AGPL verfügbar; der CLA
ermöglicht dem Copyright-Halter zusätzlich eine optionale kommerzielle
Lizenzierung.

### Drittsoftware

`streaming/` enthält das Pulse-eigene Tooling rund um den **GPU Screen Recorder**
(GSR). Der GSR selbst ist **nicht** Teil dieses Repositorys — er wird zur
Laufzeit aus dem Upstream gebaut (`streaming/bootstrap-gsr.fish`) bzw. im
Flatpak gebündelt und steht unter seiner eigenen Lizenz. GSR läuft als separater
Subprozess-Sidecar (kein Linking).
