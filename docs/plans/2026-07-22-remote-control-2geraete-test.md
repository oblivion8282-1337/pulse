# Fernsteuerung — 2-Geräte-Test + TURN (Vorbereitung, 2026-07-22)

M3 ist gebaut (6 Scheiben, `feat/remote-control-windows`). Dieser Test schaltet
die Pipeline zwischen zwei echten Geräten scharf. Hier steht, was dafür laufen
muss, welche Wege es gibt, und wie TURN reinkommt.

## Was der Test wirklich braucht (drei Teile, alle auf dem Branch)

1. **Backend mit M1** — die `remote_*`-WS-Ops + das `REMOTE_CONTROL`-Recht leben
   im chat-gateway (`ws_remote_handlers.py`, `remote_registry.py`) **nur auf
   diesem Branch**. Das Prod-Backend (howispulse.com) kennt sie NICHT → eine
   `remote_request`-Op käme dort als „unknown op" zurück. **Der Test braucht ein
   Backend, das den Branch-Code fährt.**
2. **M3-Web auf BEIDEN Geräten** — Controller und Host laden dieselbe (Branch-)
   Web-App. Die installierte Prod-App lädt das *deployte* Web und hätte M3 nicht.
3. **Host = Desktop + remote-fähiger Sidecar** — die Windows-App (Electron) mit
   dem frisch gebauten `target/release/pulse-win-hq-sidecar.exe` (hat die
   `remote_start/signal/stop`-Ops; auf diesem Branch neu gebaut), und der Host
   muss in einen Voice-Channel **HQ-streamen** (Modus A teet den laufenden Stream).

## Wege, das Backend-mit-M1 bereitzustellen

- **A — Self-Host-Test-VPS** (empfohlen fürs Testen): der alte Hetzner-VPS
  (`michael@77.42.71.166`) lebt als Self-Host-Test-Instanz. Branch-Images dort
  deployen → echtes Backend mit M1, **ohne Prod anzufassen**. Beide Geräte zeigen
  auf diese Instanz.
- **B — Voller lokaler Stack auf dem Linux-Rechner**: Postgres/Redis/LiveKit/
  MediaMTX + die 6 Services aus dem Branch. Der Linux-Rechner kann `network_mode:
  host` (Windows/Docker-Desktop nicht) → hier lauffähig. Aufwändiger, aber kein
  Deploy.
- **C — Prod deployen**: schnell, aber ungetesteten WebRTC-Code auf howispulse.com
  — erst nach dem Verhaltens-Test sinnvoll, nicht davor.

## Host-Setup (Windows, dieser Rechner)

Electron-Dev gegen lokales Vite, das aufs Test-Backend zeigt:

1. Web: `cd web`, `$env:PULSE_DEV_API_ORIGIN = "<test-backend-origin>"; pnpm dev --host`
   (`--host` bindet auf 0.0.0.0, damit das zweite Gerät im LAN drankommt).
2. Electron-Dev: `cd desktop`, `$env:PULSE_DEV_URL = "http://localhost:5173"; pnpm dev`.
   Der Sidecar-Resolver findet automatisch `target/release/…exe` (remote-fähig).
3. Im Fenster: Voice-Channel joinen, **HQ-Stream starten** (Rakete). Der Host ist
   jetzt streambar und fernsteuerbar.

## Controller-Setup (zweites Gerät)

- Browser auf `http://<host-LAN-ip>:5173` (dasselbe Vite). Einloggen, in denselben
  Voice-Channel, den HQ-Stream des Hosts ansehen (WhepPlayer).
- Im WhepPlayer unten links **„Fernsteuerung anfragen"** (nur sichtbar mit
  `REMOTE_CONTROL`-Recht — im Test-Backend dem Controller-User geben).

## Ablauf + was zu beobachten ist

1. Controller klickt Anfragen → beim Host poppt der **Consent-Dialog** (Scheibe 5).
2. Host klickt **Erlauben** → beide gehen auf „verbinden", der Controller sieht das
   **Viewer-Overlay** (Scheibe 5), das Host-Banner erscheint beim Host.
3. **Kommt das Bild an?** Das Viewer-`<video>` zeigt den Host-Bildschirm.
4. **Landen Eingaben?** Mauszeiger über dem Video bewegen → der Host-Cursor folgt
   (Absolut-Modus). „Maus einfangen" → Pointer-Lock/Relativ (für Spiele). Klicks/
   Tasten wirken am Host.
5. **Beenden** (Viewer „Kontrolle abgeben" ODER Host-Banner „Beenden") → sofort weg.

**Logs lesen:**
- Host `sidecar.log` (`%APPDATA%\Pulse\sidecar.log`): `remote_start`, `remote_signal`
  (offer rein / answer+ice raus), `remote_state connected`. Ein `[hq-crash]`/Panic
  wäre ein Bug.
- Browser-Konsole (beide Geräte): `[remote]`-Zeilen bei Signal-/WebRTC-Fehlern.
- Kein Bild → SDP/ICE prüfen (kamen answer + candidates?), Annex-B-Verdacht (M2b).
- Bild, aber kein Input → DataChannel offen? (`inputOpen`), Hello gesendet?

## TURN

- **Gleiches LAN:** STUN + Host-Kandidaten reichen meist → **erster Test ohne
  TURN möglich** (der Code hat STUN als Default).
- **Netzübergreifend:** TURN ist Pflicht (reine Consumer-Anschlüsse scheitern
  direkt, Messung 2026-07-21). Naht ist gelegt: `web/src/lib/remote/iceConfig.ts`
  → `setIceServers([...STUN, {urls:'turn:…', username, credential}])` **vor**
  Session-Start setzen. Beide Seiten (Controller + Host-Sidecar) lesen von dort.
- **Zielarchitektur** (noch zu bauen): coturn-Server (regional) + ein Backend-
  Endpoint, der **zeitlich begrenzte HMAC-Creds** ausgibt (coturn `use-auth-secret`,
  analog zum WHEP-Token-Minting). Der Client holt sie beim Session-Start und ruft
  `setIceServers`. Offene Infra-Entscheidungen: wo läuft coturn (netcup-Prod-VPS?
  eigene Box?), Realm/Secret, Ports (3478/5349 + Relay-Range) + UFW.
