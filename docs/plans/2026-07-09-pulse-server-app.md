# Plan: Pulse Server-App (Self-Hosting auf eigener Hardware)

> **ZURÜCKGESTELLT — der Weg ist abgeschaltet.** (Vermerkt 2026-08-04.)
>
> `web/src/lib/featureFlags.ts` setzt `APP_HOSTING_ENABLED = false`; die
> Download-Karte und die App-Host-Option sind damit ausgeblendet. Den Nutzern
> wurde es am 2026-07-14 auch so gesagt: „Einen Pulse-Server direkt auf dem
> eigenen Gerät zu betreiben, ist vorerst nicht mehr verfügbar."
> Übrig bleibt Self-Hosting auf einem VPS.
>
> **Das ist eine Produktentscheidung, keine technische Sackgasse** — der Code
> ist da und der Schalter umlegbar. Wer hier weiterbaut, sollte trotzdem zuerst
> klären, ob die Entscheidung noch gilt, statt gegen ein abgeschaltetes Feature
> zu entwickeln.

## Kontext — warum dieser Plan

Ursprüngliche Idee: App-Hosting **in der Pulse-Client-App** (Workstation wird zum
Server, UPnP öffnet Ports). Das ist an **zwei Dingen gescheitert**:

1. **UPnP ist die falsche Mechanik**: viele Router (Fritz!Box default) erlauben kein
   UPnP-**Schreiben** (Portfreigaben anlegen) → `AddPortMapping` 403. UPnP-Schreib ist
   auch generell fragil/sicherheitskritisch.
2. **Eine Workstation ist kein Server** (aus, daily-use, wechselnde IP).

**Pivot (mit User, 2026-07-09):** stattdessen eine **separate Pulse Server-App** — eine
gestrippte App, die **nur den Server** hostet, auf einem **Always-on-Gerät** (Mac Mini,
NUC, Pi-mit-Desktop). Pulse-Client bleibt reiner Client. VPS-Self-Host bleibt erhalten.

## Bewiesenes Fundament: Lochung funktioniert (2026-07-09)

STUN-Sonden an der Fritz!Box des Users (Cone-NAT-Test, Host + Container):

```
Host:      3 STUN-Server → identisch 46.128.100.64:<port>   → Cone-NAT ✓
Container: bind 7882, -p 7882:7882 → 3× 46.128.100.64:7882  → Cone + Port erhalten ✓
```

→ **Full-Cone-NAT + Port-Preservation durch den vollen Stack (Container→Docker→Fritz!Box→Internet).**
LiveKit (`use_external_ip: true`, in `templates/livekit.yaml.template` schon konfiguriert)
locht ohne Portfreigabe/statische IP/UPnP. **Bandbreite bleibt beim Gerät, nichts über netcup**
(außer PMs). CGNAT/symmetrisch-NAT-User: kein Voice/Stream (kein Relay — bewusst).

## Architektur

- **Vehicle**: Pulse Server-App = Hosting-Maschinerie + minimales UI, auf Always-on-Gerät.
  *Empfehlung*: als **Build-Mode des bestehenden `desktop/`-Codebase** umsetzen (ein Codebase,
  zwei Produkte: Client + Server), NICHT neue Codebase. Hosting-Code (localBackend/*) wird
  shared; Server-Produkt startet im Server-Modus (eigenes Renderer, eigener App-Name/Icon).
  → ~90 % Wiederverwendung, eine Build-Pipeline.
- **Inhalt direkt aufs Gerät** (Text/Voice/Stream), **nicht** über Relay — wie VPS-Self-Host.
  PMs über Pulse-Cloud.
- **Adressierung (dyn. IP, ohne DDNS, ohne Relay)**: Pulse-Cloud als **Directory** — Server-App
  meldet aktuelle öffentliche IP:Port (outbound, periodisch); Client fragt ab + verbindet
  **direkt**. Cloud speichert nur die Adresse, **kein Content**.
- **TLS**: Pulse stellt Cert für die Direktadresse aus (kontrolliert die Domain).
- **Medien**: Lochung (LiveKit/MediaMTX ICE, `use_external_ip`), kein UPnP/Freigabe nötig.

## Phasen

1. **Server-App-Shell**: Server-Modus im `desktop/`-Codebase; minimales Renderer (Login/Bootstrap
   → Server starten → Status + Direktadresse + Diagnose). Hosting-Code shared.
2. **Directory**: Cloud speichert Instanz-IP:Port; Server-App meldet periodisch; Client löst auf.
   + Cert-Provisioning für die Direktadresse.
3. **Verpackung**: electron-builder → Flatpak (Linux, hier bauar), NSIS (Win, cross-bauar),
   DMG (Mac — **braucht macOS** für Signierung/Notarisierung; auf Linux nur unsigniert).
4. **Always-on**: erstmal simpel — Auto-Start beim Boot/Login (Linux Autostart, Mac Login-Item,
   Win Startup). Kein Daemon-Zirkus. (Container läuft detached; App ist Kontrollpanel.)
5. **Aufräumen**: App-Hosting **aus dem Client entfernen**; UPnP-Branch (`feat/apphost-upnp-portmapping`)
   verwerfen oder als optionale Auto-Freigabe im Server-App-Codebase recyceln.

## Offene Entscheidungen (mit User)

- **Build-Mode (ein Codebase) vs. separate Codebase**? — Empfehlung: Build-Mode.
- **Server-UI-Umfang** (minimaler Status vs. mehr Konfig).
- **Mac-Build**: macOS-Box verfügbar? (Sonst nur unsigniertes Linux-cross-DMG.)

## Verifikation (pro Phase)

- Phase 1: Server-App startet, lädt Container, paart (Reuse der bestehenden Host-Tests).
- Lochung final: Server-App auf User-Gerät → Client von **extern** (Handy/Cellular) → Voice
  verbindet ohne Freigabe. (Cone-Beweis ist die starke Vorbedingung; das hier der End-to-End-Beweis.)
- Directory: IP-Wechsel am Gerät → Client findet ihn über die Cloud trotzdem.
- Verpackung: Installer installieren + App startet auf jew. Plattform.
