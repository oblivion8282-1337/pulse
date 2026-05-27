# CDP-Toolkit für Live-UI-Tests

Hilfsskripte, mit denen sich mehrere Chromium-Instanzen parallel via Chrome
DevTools Protocol fernsteuern und beobachten lassen. Praktisch wenn man
einen Multi-User-Flow (Alice + Bob + Admin) manuell oder ferngesteuert
durchklicken will, ohne mehrere Browser-Profile von Hand zu jonglieren.

Die Skripte hängen sich an einen **laufenden** Chromium an (nicht an einen
durch Playwright frisch gestarteten). Das `launch.fish`-Skript stellt
Chromium mit dem richtigen `--remote-debugging-port` + isoliertem Profil
bereit, die anderen drei docken über CDP-HTTP auf 127.0.0.1:`<port>` an.

## Setup

Voraussetzungen:

- `chromium` im PATH (Arch: `pacman -S chromium`).
- Node ≥ 18 — die Node-Skripte lösen `@playwright/test` selbst aus
  `web/node_modules/` auf (via `createRequire` mit explizitem Basispfad),
  Aufruf geht aus jedem Verzeichnis.
- Pulse-Dev-Stack läuft (`scripts/dev-up.fish` → Vite auf :5173).

```fish
# Aus dem Repo-Root:
node scripts/cdp/observe.mjs 9222
```

## Skripte

| Skript | Was es tut |
|---|---|
| `launch.fish <port> <profile> [url]` | Startet Chromium mit CDP auf `<port>`, eigenem Profil unter `/tmp/pulse-cdp-profile-<profile>/`. Default-URL `http://127.0.0.1:5173/`. |
| `observe.mjs <port>` | Hängt sich an :`<port>` an, loggt Console-Events, pageerrors, fehlgeschlagene Requests und HTTP-4xx/5xx-Antworten nach `/tmp/pulse-cdp-events-<port>.log`. Mit `tail -f` mitlesen. |
| `shot.mjs <port> <output> [--full]` | Schreibt einen Screenshot des ersten Pulse-Tabs (:5173) auf `<port>`. `--full` macht `fullPage:true`. |
| `drive.mjs <port> <action> [args…]` | Aktive UI-Steuerung. Actions: `navigate <path>`, `click <selector>`, `fill <selector> <value>`, `eval <js>`, `wait-for <selector>`, `login <identifier> <password>`. |

## Typischer Multi-User-Test

```fish
# Drei Chromium-Instanzen für Alice / Bob / Admin
./scripts/cdp/launch.fish 9222 alice
./scripts/cdp/launch.fish 9223 bob
./scripts/cdp/launch.fish 9224 admin

# Beobachter pro Instanz (im Hintergrund)
nohup node scripts/cdp/observe.mjs 9222 > /dev/null 2>&1 &
nohup node scripts/cdp/observe.mjs 9223 > /dev/null 2>&1 &
nohup node scripts/cdp/observe.mjs 9224 > /dev/null 2>&1 &

# Login fahren (z.B. Admin)
node scripts/cdp/drive.mjs 9224 login user@example.test SeinPasswort
node scripts/cdp/drive.mjs 9224 navigate /app/admin
node scripts/cdp/shot.mjs 9224 /tmp/admin.png --full
```

## Cleanup

```fish
pkill -f 'cdp/observe\.mjs'
pkill chromium                           # alle CDP-Instanzen schließen
rm -rf /tmp/pulse-cdp-profile-*          # Profile löschen
rm -f /tmp/pulse-cdp-events-*.log        # Logs löschen
```

## Stolperstellen

- **Login-Form-Selektoren** sind testid-basiert (`data-testid="login-identifier"`,
  `login-password`, `login-submit`) — robust gegen Refactoring.
- Pulse-Auth ist **Cert-basiert** (IndexedDB pro Profil). Re-Use eines
  Profils heißt: das Cert ist noch da → man bleibt eingeloggt. Komplett
  fresh starten = `rm -rf /tmp/pulse-cdp-profile-<name>` vor `launch`.
- `@playwright/test` lebt im `web/`-Workspace. Die Node-Skripte lösen
  es selbst über `createRequire(resolve(__dirname, '../../web/'))` auf —
  also egal aus welchem cwd man sie startet, wichtig ist nur die
  relative Pfad-Struktur `scripts/cdp/` ↔ `web/node_modules/`.
- HTTP-Status-Logging filtert auf `>= 400` — ein leerer Log heißt: kein
  Error, nicht: nichts passiert.
