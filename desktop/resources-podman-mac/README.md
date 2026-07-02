# resources-podman-mac/

Zielordner für das gebündelte Podman im Mac-Build (App-Hosting Phase 3).
`scripts/fetch-mac-podman.sh` (Teil von `dist:mac`) lädt hier SHA-gepinnt
`podman`, `gvproxy` und `vfkit` hinein; `electron-builder.yml` packt den Inhalt
nach `Contents/Resources/podman/`, wo `containerRuntime.ts` ihn als ersten
Kandidaten findet (und `CONTAINERS_HELPER_BINARY_DIR` auf den Ordner setzt,
damit podman machine gvproxy/vfkit findet).

Binärdateien hier NIE committen (.gitignore greift) — nur diese README lebt im Git.
