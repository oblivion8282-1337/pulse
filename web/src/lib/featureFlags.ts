/**
 * Zentrale Feature-Flags (Build-Zeit-Konstanten).
 *
 * Bewusst KEINE Server-/Env-Steuerung — diese Flags blenden Features aus, die
 * noch nicht end-to-end fertig sind, damit User sie nicht „entdecken" und etwas
 * anfragen, das nicht funktioniert. Zum Wieder-Einschalten: auf `true` setzen.
 */

/**
 * App-Hosting (Pulse-Server lokal aus der Desktop-App heraus hosten, Relay-basiert).
 *
 * AN seit 2026-07-02: die Geräte-Seite startet den allinone-Container über die
 * Container-Runtime des Systems (Linux-Flatpak: Host-Podman via flatpak-spawn;
 * sonst Podman/Docker im PATH; frpc-Tunnel läuft im Image). Fehlt eine Runtime,
 * zeigt die Karte einen ruhigen Setup-Hinweis (hostStore.runtimeOk) — gebündeltes
 * Podman für Win/Mac folgt (Phase 2/3, docs/superpowers/plans/2026-06-29-…).
 * Self-Hosting (eigener VPS) ist davon UNBERÜHRT.
 */
export const APP_HOSTING_ENABLED = true;
