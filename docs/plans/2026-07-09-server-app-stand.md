# Stand: Pulse Server-App (2026-07-09)

## Entscheidungen (diese Session)

- **Pivot** weg von UPnP / In-Client-App-Hosting → **separate Pulse Server-App** (gestrippte App, nur Hosting) auf einem Always-on-Gerät (Mac Mini / NUC / Pi). Pulse-Client bleibt reiner Client; VPS-Self-Host bleibt.
- **Server-App = Build-Mode** des `desktop/`-Codebase (ein Codebase, zwei Produkte, `__APP_MODE__` per esbuild-define).
- **Medien per WebRTC-Lochung** (kein UPnP, keine Portfreigabe, keine statische IP) — bewiesen: Fritz!Box = Full-Cone-NAT + Port-Preservation durch den vollen Stack.
- **Alles direkt aufs Gerät** (Text + Voice + Stream), **nichts über netcup** (außer PMs). Hartes User-Constraint.
- **Login in der Server-App** wie der normale Pulse-Client (kein Token-Paste) → "Server einrichten" auto-provisioniert.

## Gebaut (Branch `feat/server-app`, 3 Commits, ungemerged)

| Commit | Inhalt |
|---|---|
| `66059008` | Server-App: Build-Mode, Login-Phase (howispulse.com → server.html nach `pulse_session`-Cookie), Auto-Provision (`serverProvision.ts`: mint+redeem via Session-Cookie), `HostLifecycle` holePunch (überspringt Port-Mapping-Gate), Linux-Flatpak `com.howispulse.PulseServer` |
| `6355df0c` | Access-Control: privilegiertes Host-IPC nur vom lokalen `server.html` (`localSenderOnly`-Guard) |
| `cd22a0f9` | Flatpak-Render-Fixes: `--device=all` + `--disable-gpu` (sonst weißes Fenster) |

## Verifiziert

- Lochung: Cone-NAT + Port 7882 erhalten durch Container→Docker→Fritz!Box (3 STUN-Server).
- Server-App: Builds (client + server), Tests (48/1, der 1 = pre-existing UDP-Flake), Login-Phase rendert, `server.html` rendert, Guard blockt Remote-Seite (CDP: `provision` aus howispulse.com → `forbidden`).
- Flatpak: baut, installiert, startet, **rendert sichtbar** (Login + server.html).

## E2E-Status (in Arbeit)

- Login ✅ (App wechselt auf "Bereit zum Einrichten").
- **"Server einrichten" → noch nicht durchgeklickt** (auto-provision: Instanz finden + mint + redeem). Nächster Schritt.
- **"Server starten" → Container (podman pull/run) → live**: offen.
- **Client verbindet via Lochung**: offen.

## Offen (Folge-Phasen)

- Full Login→Einrichten→Start→live + echter Client (Voice/Stream über Lochung) verifizieren.
- App-Hosting **aus dem Client entfernen**.
- Cloud-Directory (dyn. IP ohne DDNS), Cert-Provisioning, Always-on (Auto-Start beim Boot).
- Mac (DMG, macOS-Box da) + Win (NSIS).
- Merge + Deploy (auf Freigabe).
- UPnP-Branch `feat/apphost-upnp-portmapping`: verwerfen oder als optionale Auto-Freigabe recyceln.

## Starten

```
flatpak run com.howispulse.PulseServer
```

Architektur/Phasen: `docs/plans/2026-07-09-pulse-server-app.md`.
