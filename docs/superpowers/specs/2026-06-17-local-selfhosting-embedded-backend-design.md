# Design-Spec: Lokales Selfhosting — Sub-Projekt ① „Embedded Backend-Bundle"

**Stand:** 2026-06-17 (rev. 2 — Option A) · **Status:** Design (vor Implementierungsplan) · **Scope:** nur ①

> **Revision 2:** Der ursprüngliche SQLite-Ansatz wurde nach Code-Erkundung verworfen. Die echten
> Alembic-Migrationen laufen nicht auf SQLite (alle starten mit `CREATE SCHEMA auth/chat` +
> schema-qualifizierten Spalten — auf SQLite Syntaxfehler; die Tests umgehen das per `create_all`),
> und der Attachment-Upload hängt an presigned S3-URLs (ein lokaler FS-Adapter müsste Back+Front
> umbauen). Beides ergäbe einen divergenten, brüchigen Code-Pfad. **Stattdessen Option A: den echten
> Stack nativ bündeln** (Postgres + Redis + MinIO + LiveKit + MediaMTX + coturn als native Prozesse,
> kein Docker) → **null Backend-Code-Änderungen**, byte-gleich zur Cloud.

## 1. Kontext & Ziel

Pulse hat heute zwei Stufen: **Cloud-Community** (Gast auf howispulse.com, null Aufwand) und
**VPS-Selfhost** (eigener Server, voller Stack via `pulse-allinone`-Container). Dieses Programm baut
die **Mittelstufe**: ein normaler User hostet eine **eigene Instanz vom eigenen Rechner aus** über die
Desktop-App — ohne Server, ohne VPS, ohne Docker.

Das ist ein Programm aus vier Subsystemen (§8). **Diese Spec deckt nur ① ab:** den bestehenden
`allinone`-Stack **Docker-frei als native Prozesse** auf dem Host laufen lassen, vom Electron-Main
orchestriert, lokal verifizierbar.

## 2. Feste Constraints (vom User bestätigt)

1. **Docker-frei** — die App bringt alles selbst mit; der User installiert nichts extra.
2. **Aller Medien-Traffic über den Host** — Voice (LiveKit-SFU), Screenshare, HQ-Streaming (MediaMTX)
   laufen auf der Host-Maschine; der Host trägt die Bandbreite.
3. **Cloud-Relay nur Steuerung** (leichtes Signaling, später ②). **Medien nie über die Cloud** —
   direkt zum Host (Hole-Punching/UPnP); striktes NAT/CGNAT braucht einmalig Port-Forwarding.
4. **Gegated / monetarisierbar** — die Cloud schaltet Selfhosting pro User frei (vorhandene
   Instance-Registry + Approval, später + Bezahl-Gate). Das Host-Backend ist ein **on-demand
   nachgeladenes Modul**, nicht Teil der schlanken Basis-App.
5. **Echter Stack, null Backend-Divergenz** (Option A) — kein SQLite/FS-Sonderpfad; der Self-Host
   läuft die identische Backend-Logik wie die Cloud.

## 3. Architektur — der `allinone`, ent-dockert

Der `pulse-allinone`-Container (`infra/self-host/`) hat die ganze Orchestrierung schon gelöst
(s6-overlay: Init-Skripte + Service-Supervision). **①  portiert diese Orchestrierung nach
Electron-Main** und ersetzt die Linux-Container-Binaries durch **per-Plattform native Binaries**.

**Komponenten** (exakt die des `allinone`, Quelle: Blueprint aus `infra/self-host/`):
- **5 Python-Services** (uvicorn, alle auf `127.0.0.1`): auth `:8001`, chat-gateway `:8002`,
  voice-signaling `:8003`, media-svc `:8004`, mediamtx-auth-hook `:8005`.
- **Datenschicht:** Postgres 15 (`:5432`), Redis 7 (`:6379`), MinIO (`:9000`) — alle loopback-only.
- **Medien:** LiveKit (`:7880` + UDP 7882–7892), MediaMTX (RTMPS `:1936`, WHEP `:8889`, API `:9997`),
  coturn (STUN/TURN `:3478`).
- **(Caddy/TLS bleibt ②** — gehört zur Erreichbarkeit nach außen; in ① bindet alles nur localhost.)

**Orchestrierung:** ein **`LocalBackendManager`** im Electron-Main, analog zum GSR-`SidecarManager`
(`desktop/electron/sidecar.ts`). Er repliziert die s6-Init-Sequenz + Supervision (§6).

**Binaries:** LiveKit · MediaMTX · MinIO · coturn · Caddy sind **plattformübergreifende Go-Binaries**
(amd64/arm64, Win/Mac/Linux). **Postgres 15** und die **Python-Runtime** brauchen per-Plattform-Builds
(z.B. eingebettete Postgres-Distributionen; Python-Embed/uv-Venv pro Plattform). Redis hat
plattform-Builds.

## 4. Persistenz — die portable „Welt"

Ein Daten-Ordner unter `<userData>/pulse-host/data/` — spiegelt das `/data`-Layout des allinone:
- `pg/` — Postgres-Daten (die Community-DB `dcc`, Schemas `auth`+`chat`)
- `minio/pulse-attachments/` — hochgeladene Bilder/Dateien
- `uploads/{avatars,guild-icons}/` — Avatare/Community-Icons
- `redis/` — Redis-AOF · `secrets/` — generierte Schlüssel (chmod 600) · `backups/` — `pg_dump`-Dumps

**„Eigene Welt" bleibt:** Der ganze Ordner ist die Community — Backup = Ordner kopieren; zusätzlich
gibt es schon den **`backup`-Dienst** (periodischer `pg_dump --format=custom`, Retention) aus dem
allinone, den wir mit übernehmen. **Keine Identität** im Ordner — Accounts bleiben in der Cloud
(Cert-Login).

## 5. Haupt-Aufgaben & Risiken von ① (Option A)

**Null Backend-Code-Änderung** ist der große Gewinn — Migrationen, S3/Attachments, Locking laufen
exakt wie in der Cloud. Die Arbeit (und die Risiken) verschieben sich auf Orchestrierung + Packaging:

1. **s6 → Electron-Main portieren** *(Kern)*: Die Init-Skripte (Daten-Dirs, Secrets, `initdb` +
   DB/Schema-Bootstrap, Config-Rendering, Migrationen `auth`→`chat`, MinIO-Bucket) und die
   Service-Supervision mit Abhängigkeits-Reihenfolge als Node/TS im `LocalBackendManager`. Quelle
   1:1: `infra/self-host/s6/...` (Blueprint).
2. **Per-Plattform-Binaries** *(Risiko)*: Postgres 15 + Python-Runtime für macOS/Windows/Linux
   beschaffen/bündeln (Go-Binaries sind unkritisch). Bezugsquelle + Signatur-Verifikation festlegen.
3. **Postgres-Daten-Dir-Lifecycle** *(Risiko)*: Das `pg/`-Dir hängt an der Major-Version — bei einem
   späteren Postgres-Upgrade braucht's `pg_upgrade` (oder lange Major-Pinning). Bewusst eingeplant.
4. **Ressourcen/Start-Zeit:** ~13 Prozesse + Postgres/MinIO brauchen RAM (~Hunderte MB) und
   gestaffelten, health-gegateten Start. Auf dem on-demand-Modul-Pfad (nicht Basis-App) akzeptabel.

## 6. Lifecycle & Fehlerbehandlung (`LocalBackendManager`)

**Start (Init-Sequenz, aus dem Blueprint):** Daten-Dirs anlegen → Secrets generieren (idempotent) →
`initdb` + DB/Schema-Bootstrap (nur Erst-Start) → Config-Files rendern (Env, livekit.yaml,
mediamtx.yml, coturn.conf) → Postgres/Redis hoch → **Migrationen** (`alembic upgrade head` für auth,
dann chat-gateway) → MinIO hoch + Bucket-Init → restliche Services gestaffelt nach Abhängigkeits-Graph,
jeweils auf `/health` bzw. TCP-Probe warten (Muster aus `pulse-health` + `_globalSetup.ts`).

**Abhängigkeits-Reihenfolge** (Blueprint §3): cont-init → postgres/redis/coturn → auth/chat/voice/
media/mediamtx-hook → minio → minio-init → livekit (nach voice-signaling) → mediamtx (nach media-svc
+ hook) → backup.

**Stop / App-Quit:** umgekehrte Reihenfolge (Caddy/Services → Medien → Redis → Postgres sauber via
`pg_ctl stop`), SIGTERM→SIGKILL-Staffel (Sidecar-Muster).

**Fehler:** Start scheitert → klare Meldung + **Rollback** (gestartete Prozesse stoppen). Prozess
stirbt → Restart mit Backoff, nach N Fehlversuchen Stack stoppen. **Niemals Secrets loggen.** Logs
pro Prozess in den Daten-Ordner.

**Persistenz über App-Close** (ephemer vs. Hintergrund) = ③/UX-Entscheidung; in ① reicht Start/Stop.

## 7. Lokale Verifikation

- **Smoke-Harness:** `LocalBackendManager` headless auf der Dev-Plattform hochfahren → auf Health
  aller Komponenten warten → Szenario: Cert-Login (Fixture-Config), Community anlegen, Nachricht +
  Anhang, **Voice-Call zwischen zwei lokalen Clients**, ein **HQ-Stream**. = End-to-End-Verifikation.
- **Pro Plattform** (Linux/Flatpak · Windows · Mac) — die nativen Binaries unterscheiden sich; das
  Walking-Skeleton zuerst auf der Dev-Plattform.
- **Grenze:** echte Instanz-Config (Instance-ID, Cloud-Secrets) kommt aus dem Bootstrap-/Cloud-Flow
  (③/④); für ①-Tests eine lokale Fixture-Config (analog `infra/self-host/.env.example`).

## 8. Zerlegung des Gesamt-Programms (Kontext)

- **① Embedded Backend-Bundle** — *diese Spec.*
- **② Erreichbarkeit** — Cloud-Rendezvous/Signaling (nur Steuerung) + direkte Medien + Port-Forward
  + Caddy/TLS nach außen.
- **③ Electron-Orchestrierung + UX + Gating** — `LocalBackendManager`-UI, „Instanz hosten"-Flow,
  Lifecycle/Persistenz, Bootstrap-Token + Monetarisierungs-Grant.
- **④ Cloud-Seite** — Bezahl-Gate vor Instance-Registry + Betrieb des Signaling-Relays.

**Bau-Reihenfolge:** ① zuerst, dann ②/③ parallel, ④ begleitend.

## 9. Offene Detail-Entscheidungen (im Plan zu klären)

1. **Ports:** feste vs. dynamische Ports (fremder Rechner → Kollisionsrisiko). *Tendenz: dynamisch.*
2. **Postgres-Bezug:** welche eingebettete Postgres-15-Distribution pro Plattform (z.B. zonky/EDB)?
3. **Python-Bundling:** Embed-Python vs. uv-managed Venv pro Plattform.
4. **Prozess-Supervision:** alles in-Process über Node-`child_process` (wie `sidecar.ts`) vs. ein
   leichter Supervisor. *Tendenz: Node-`child_process`, ein `LocalBackendManager`.*

## 10. Außerhalb des Scope von ①

- Erreichbarkeit/Relay/Port-Forwarding + Caddy/TLS nach außen (②).
- „Instanz hosten"-UI, Modul-Download, Monetarisierungs-Freischaltung, Persistenz-bei-App-zu (③/④).

## 11. Erfolgskriterien für ①

Ein Host-Modul lässt sich auf der Dev-Plattform (dann Win/Mac/Linux) headless hochfahren, läuft
**Docker-frei** mit dem **echten Stack** (Postgres/Redis/MinIO/LiveKit/MediaMTX/coturn als native
Prozesse), Migrationen laufen unverändert, und es besteht den Smoke-Harness (Cert-Login → Community →
Nachricht+Anhang → Voice-Call → HQ-Stream) — alles auf `localhost`, ohne Docker und ohne
Backend-Code-Divergenz.
