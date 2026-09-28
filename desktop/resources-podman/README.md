# resources-podman/

> **VERALTET seit 2026-07-14.** Beides ist längst wieder raus: Die CI lädt keine
> Podman-Binaries mehr (der Download-Step ist aus `.github/workflows/win-build.yml`
> gestrichen) und `electron-builder.yml` bündelt den Ordner nicht mehr
> (extraResource entfernt) — App-Hosting ist geparkt. Zum Reaktivieren siehe die
> Kommentare an beiden Stellen. Was folgt, ist Historie.

Zielordner für das gebündelte Podman im Windows-Installer (App-Hosting Phase 2).
Die CI (`.github/workflows/win-build.yml`) lädt hier vor `dist:win` SHA-gepinnt
`podman.exe`, `gvproxy.exe` und `win-sshproxy.exe` aus dem offiziellen
podman-remote-release-windows_amd64.zip hinein; `electron-builder.yml` packt den
Inhalt nach `resources/podman/` neben die asar, wo `containerRuntime.ts` ihn als
ersten Kandidaten findet.

Lokal bleibt der Ordner leer (nur diese README) — die Runtime-Detection fällt
dann auf Podman/Docker im PATH zurück. Binärdateien hier NIE committen.
