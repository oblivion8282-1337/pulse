# Umsetzungsplan: App-Hosting auslieferbar machen — „ein Knopf, der Rest passiert von selbst"

**Status:** Plan / noch nicht gebaut (2026-06-29). App-Hosting ist in der UI ausgeblendet
(`web/src/lib/featureFlags.ts` → `APP_HOSTING_ENABLED = false`). Dieser Plan beschreibt, wie wir es
auslieferbar machen und den Flag wieder einschalten.

**Verwandt:**
- `docs/superpowers/specs/2026-06-17-selfhost-control-plane-relay-design.md` — Relay-Grunddesign.
- `docs/superpowers/specs/2026-06-29-apphost-direct-chat-webrtc-datachannel.md` — separate, spätere
  Idee (Chat/Uploads direkt via WebRTC, am Relay vorbei). **Unabhängig** von diesem Plan.

---

## 1. Ziel

Ein User, der aus der App heraus hosten will, **drückt einen Knopf — sonst nichts.** Die App holt
sich alles selbst und startet einen kompletten Pulse-Server auf seinem Gerät. **Auf allen
Plattformen** (Linux/Windows/Mac). Identität/Login bleibt Cloud (Cert-Modell); der Server selbst
läuft lokal, von außen erreichbar über den Relay.

---

## 2. Der Perspektivwechsel: nicht „Docker", sondern „ein Linux-Runtime pro OS"

Wir haben das **All-in-One-Image** bereits (`infra/self-host/Dockerfile`, s6-überwacht: Postgres,
Redis, MinIO, alle Python-Dienste; gebaut von `.github/workflows/allinone.yml`; von VPS-Self-Hostern
genutzt). Damit ist das **schwierigste Stück — den ganzen Stack cross-platform paketieren — bereits
gelöst.** Docker abstrahiert das OS.

Was fehlt, ist NICHT „Docker bündeln", sondern: **eine minimale Linux-Ausführungs-Umgebung pro OS,
in der unser Image läuft.** Docker/Podman sind nur *ein* Weg dahin (und der schwerste; Docker Desktop
ist groß + kommerziell kostenpflichtig). Wir nutzen pro OS den **leichtesten, eingebauten** Weg.

### Die eine unverrückbare Wahrheit
Docker-Images sind Linux-Programme → brauchen einen Linux-Kernel.
- **Linux:** Kernel ist da → **kein VM**, läuft direkt.
- **Windows/Mac:** **kein** Linux-Kernel → es **muss** im Hintergrund ein winziges Linux laufen
  (WSL2 bzw. Virtualization.framework). Nicht wegzaubern-bar; jedes Tool macht das. Wir
  liefern/automatisieren es, eliminieren es aber nicht ganz.

---

## 3. Architektur pro Plattform

### 3.1 Linux — Flatpak + Host-Podman (der entscheidende Punkt)

**Constraint (zwingend):** Auf immutable/atomaren Distros (**Bazzite**, Silverblue, Bluefin, Aurora,
Kinoite) ist das Basissystem schreibgeschützt → **native Installation fällt weg, Flatpak ist Pflicht.**
Pulse ist auf Linux ohnehin schon Flatpak (`com.howispulse.Pulse`).

**Lösung:** Der Flatpak bündelt Podman **nicht** und fährt es **nicht** im Sandbox (nested
Podman-in-Flatpak ist fragil). Stattdessen: genau diese atomaren Distros **liefern Podman im
Basissystem mit** (Bazzite & Co. = Podman + Distrobox standardmäßig). Der Flatpak **bittet das
Host-Podman**, unser Image zu starten — über den Flatpak-Standard **`flatpak-spawn --host`**
(Berechtigung `--talk-name=org.freedesktop.Flatpak`).

**Präzedenz:** **Boxbuddy** (Flathub-Flatpak) steuert exakt so die Host-Container (Distrobox/Podman).
Das Muster ist erprobt + Flathub-akzeptiert. Wir machen dasselbe für *ein* Image.

**Ablauf (Linux):**
1. Flatpak holt Zugangsdaten aus dem Pairing (siehe §4).
2. `flatpak-spawn --host podman pull ghcr.io/.../pulse-allinone:latest` (einmalig).
3. `flatpak-spawn --host podman run ...` mit der erzeugten `.env` → Container läuft **host-seitig**
   (richtig so: Relay-Tunnel + Medien-Ports funktionieren auf Host-Ebene).
4. Mini-UI: „läuft / gestoppt".

**Vorteil:** kein Podman-Bündeln, kein Sandbox-Kampf, keine native Installation. Auf Bazzite & Co.
ist Podman garantiert → idiomatischster, reibungsärmster Weg. **Darum ist Linux der erste Meilenstein.**

**Restpunkte Linux:**
- Abhängig von Host-Podman: auf immutable Distros garantiert; auf manchen schlanken *mutable* Setups
  evtl. nicht → erkennen + freundlich hinweisen (Fallback).
- `--talk-name=org.freedesktop.Flatpak` ist eine breite Berechtigung (Host-Befehle) — Flathub prüft
  genauer, aber akzeptiert (Boxbuddy).
- Image (~mehrere hundert MB) liegt im Host-Podman-Storage, nicht im Flatpak.

### 3.2 Windows — WSL2

Windows bringt mit WSL2 einen echten Linux-Kernel mit (Win10 2004+/Win11, gratis, steuerbar).
- **Primärweg:** Podman + `podman machine` (nutzt intern WSL2). Apache-2.0, kein Docker-Desktop-Geld.
- **Leichter (später):** unser Image-Rootfs **direkt als WSL2-Distro importieren** (`wsl --import`) und
  s6 darin starten — ganz ohne Container-Engine.
- **Erststart-Haken:** WSL muss einmal aktiviert sein (`wsl --install`) → kann **einmalig** Admin +
  Neustart kosten; Virtualisierung muss im BIOS an sein (meist). Danach: ein Knopf, für immer.
  → Geführter Erststart-Assistent.

### 3.3 Mac — Virtualization.framework

macOS bringt ab 11 eine leichte VM-Technik mit; Apple Silicon + Intel.
- **Primärweg:** Podman + `podman machine` (nutzt auf Apple Silicon `applehv`/libkrun).
- **Leichter (später):** Image-Rootfs direkt in einer Mini-VM (libkrun/vfkit) booten.
- **Haken:** VM-Image wird einmal geladen; macOS 13+ für die besten APIs; kein Neustart nötig.

### 3.4 Übersicht

| System | Linux-Runtime | „Nur-ein-Knopf"? | Bündeln wir? |
|---|---|---|---|
| **Linux (Flatpak)** | **Host-Podman** via `flatpak-spawn --host` | ✅ (Podman vom System) | nein — nutzt Host |
| **Windows** | WSL2 (Podman machine) | ✅ nach einmaliger WSL-Aktivierung | Podman + Glue |
| **Mac** | Virtualization.framework (Podman machine) | ✅ nach VM-Erstdownload | Podman + Glue |

---

## 4. Was bereits gebaut ist (wiederverwendbar)

- **All-in-One-Image** (`infra/self-host/`) — der ganze Stack in einem Image. ✅
- **Relay-Infrastruktur** live auf netcup (`infra/prod/` frps + relay-frps-plugin + Caddy `*.relay`,
  DNS-Wildcard) — Stand 2026-06-29 aktiv. ✅
- **Pairing** (Bootstrap-Token → Relay-Subdomain + Tunnel-Token + Creds):
  `services/auth/src/dcc_auth/routes_selfhost_bootstrap.py` + `desktop/electron/localBackend/pairing.ts`. ✅
- **`.env`-Erzeugung** (`desktop/electron/localBackend/renderConfig.ts`,
  `generate_env_file` in `routes_instance_applications.py`). ✅
- **Cloud-Seite App-Hosting** (Antrag → Genehmigung → Auto-Instanz → Owner-Stufe): live. ✅
- **Orchestrierungs-Logik** (`desktop/electron/localBackend/localBackendManager.ts`) — heute startet
  sie **native Prozesse via `uv run`** (Dev-only). Wird umgebaut auf **„einen Container starten"**
  (drastisch weniger Code: statt 7 Prozesse jonglieren → `podman run` + Tunnel + Health).

**Wegfallen/umbauen:** der native-Prozess-Manager (`components.ts` mit `uv run`, `postgres.ts`,
`media.ts`) wird durch einen schlanken **Container-Host-Manager** ersetzt.

---

## 5. Vorarbeiten / Prerequisites

1. **All-in-One-Image multi-arch bauen** (linux/amd64 **und** linux/arm64) — sonst läuft's auf
   Apple-Silicon-Macs nur langsam emuliert. `allinone.yml` erweitern (buildx).
2. **`frpc` (Tunnel) verorten:** entweder in das All-in-One-Image mit aufnehmen (sauberer, ein
   Container = alles) oder als Sidecar daneben starten. Entscheidung treffen. Empfehlung: **ins
   Image** (das Image weiß dann selbst, wie es sich nach außen anbindet).
3. **Image-Distribution:** beim ersten Start aus GHCR ziehen (kleiner Installer, braucht Netz) **vs.**
   mitliefern (großer Installer, offline/deterministisch). Empfehlung: **ziehen** (das Image rotiert,
   GHCR ist eh die Quelle); Fortschrittsanzeige im Knopf-Flow.
4. **Flatpak-Manifest** um `--talk-name=org.freedesktop.Flatpak` ergänzen (Host-Spawn).
5. **App-Host-Instanz aus der VPS-„Meine Instanzen"-Liste raushalten** (UX-Punkt vom 2026-06-29-Test):
   App-Host-Instanzen sollen NICHT mit dem VPS-„Server einrichten"-Flow erscheinen. Entweder per
   Marker-Spalte (`origin = 'app_host'|'vps'` auf `registered_instances`) oder am synthetischen
   Hostname-Präfix `app-` erkennen. Frontend filtert sie aus `MyInstances` und zeigt sie nur in der
   App-Hosting-Karte.

---

## 6. Knopf-Flow (Renderer + Host-Manager)

„Server starten" löst aus:
1. **Runtime sicherstellen:** Linux → Host-Podman da? Win/Mac → `podman machine` init/start (mit
   Erststart-Assistent, falls WSL/Virtualisierung erst aktiviert werden muss).
2. **Image laden** (pull, mit Fortschritt).
3. **Pairing** (falls noch nicht): Bootstrap-Token minten → einlösen → `.env` + Relay-Subdomain +
   Tunnel-Token (alles schon gebaut).
4. **Container starten** mit der `.env` (+ Tunnel).
5. **Medien-Ports** am Heimrouter öffnen (NAT-PMP, `portMapper.ts` — schon da).
6. **Health + Mini-UI:** „läuft" / „gestoppt" / „dein Heimnetz ist nicht erreichbar" (CGNAT-Hinweis).

Folge-Starts: nur `machine start` (Win/Mac) + `run`. Sekunden.

---

## 7. Ehrliche Grenzen (unabhängig von der Paketierung)

- **Gerät muss an sein**, damit der Server erreichbar ist.
- **CGNAT** (manche Mobilfunk-/Glasfaser-Anschlüsse): Voice/Streaming-Medien gehen direkt zum Gerät →
  ohne erreichbares Heimnetz nicht. Die App erkennt das vorab (`reachability.ts`,
  `hostLifecycle.ts`) und sagt es ehrlich.
- **Win/Mac Erststart:** Virtualisierung muss an sein; Windows evtl. einmal Admin + Neustart (WSL).
  Danach ein Knopf. Nicht zu 100 % wegautomatisierbar — aber geführt.

---

## 8. Phasen & grobe Schätzung

| Phase | Inhalt | Aufwand |
|---|---|---|
| **0. Prereqs** | Image multi-arch, frpc-Verortung, App-Host-Instanz aus VPS-Liste filtern | ~1 Woche |
| **1. Linux (Flatpak + Host-Podman)** | Host-Container-Manager, `flatpak-spawn --host`, Knopf-Flow, Mini-UI | **~2–3 Wochen** |
| **2. Windows (WSL2 + Podman machine)** | Podman bündeln, Erststart-Assistent, Glue | ~2–4 Wochen |
| **3. Mac (Virtualization.framework)** | Podman machine, VM-Image, Signierung/Notarisierung | ~2–4 Wochen |
| **4. Härtung** | Reconnect, Sleep/Wake, Fehlerzustände, echte Geräte-Tests | laufend |

**Linux-Durchstich (Phase 0+1) ist der erste, klar machbare Meilenstein** — und Bazzite-/Immutable-
Nutzer sind die natürliche erste Zielgruppe (Podman garantiert).

---

## 9. Offene Entscheidungen

- Podman-machine-Weg (robust, mehr Disk) **vs.** Image-Rootfs direkt in WSL2/libkrun (leichter, mehr
  Eigenbau). Empfehlung: **Podman zuerst**, später ggf. optimieren.
- `frpc` im Image vs. Sidecar (§5.2).
- Image mitliefern vs. ziehen (§5.3).
- Marker-Spalte `origin` auf `registered_instances` vs. Hostname-Heuristik (§5.5).

---

## 10. Wieder-Einschalten

Wenn Phase 1 steht: `APP_HOSTING_ENABLED = true` in `web/src/lib/featureFlags.ts` (blendet die
App-Hosting-Karte + das Admin-Panel wieder ein). Self-Hosting (VPS) ist davon unberührt.
