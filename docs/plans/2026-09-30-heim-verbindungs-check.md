# Verbindungs-Check für Heim-Server — Entscheidung (2026-09-30)

*Anlass: Button-Test + Linux-E2E zeigten, dass die Heim-Server-Kette neue
Glieder hat, die die VPS-Diagnose nicht kennt — vor allem das NAT-Loch
(Direktpfad von außen) und den Relay-Tunnel. Der Nutzer soll selbst durchklicken
können, was funktioniert und wo etwas klemmt — dasselbe Muster wie die
Instance-Diagnose der VPS-Selfhoster (Button „Verbindung prüfen" auf „Meine
Instanzen", Kette von außen, erster roter Schritt = Ursache, je Schritt ein
„Was tun"-Handgriff, ungeprüfte Glieder werden genannt).*

## Entscheidung (User, 2026-09-30, AskUserQuestion)

**Stufe 1 + 2 bauen; Stufe 3 (Freund-Ansicht im Beitritts-Dialog) später.**

## Die Heim-Server-Kette (Reihenfolge = Ursachenkette)

1. **telefonbuch** (Cloud, neu): meldet sich der Adapter per Heartbeat? Eintrag
   in `InstanceDirectEndpoint` vorhanden und jünger als 300 s
   (`directory_online_threshold_seconds`).
2. — die bekannte Hostname-Kette gegen die **Relay-Adresse** (DNS → TCP 443 →
   TLS → health → Identität → Betreiber → Anmeldeweg → CORS → WebSocket):
   beweist die Tunnel-Kette frpc → frps → Container-Caddy.
3. **stun/rtmps entfallen** für app_host: die beiden VPS-Medienschritte zielen
   auf die Relay-Box, nicht auf den Heim-Router — dort sind sie ohne Aussage.
   Sie erscheinen für Heim-Instanzen ehrlich unter „nicht geprüft".

## NAT-Loch von der Cloud aus: NICHT prüfbar (empirisch belegt 2026-09-30)

Der Plan sah einen STUN-Binding-Request der Cloud an die Telefonbuch-Adresse
vor. Empirie auf der Hetzner-Box gegen die echte Instanz: der Adapter
antwortet auf nacktes STUN (ohne ICE-USERNAME/INTEGRITY) NICHT (webrtc-rs
verwirft still), und coturn/3478 hat am Heim-Router kein NAT-Fenster (nie
durchgereicht, kein UPnP). Ein Cloud-seitiger Nachweis des NAT-Lochs bräuchte
einen echten ICE-Check mit gültigem ufrag — das geht nur aus einem echten
Client → **Stufe 3**. Optional später (1b): der Adapter vergleicht
STUN-Spiegel-Port gegen gebundenen Port (Port-Erhaltung) und melde das im
Heartbeat als Hinweis — Plausibilität, kein Beweis.

## Stufe 1 — Cloud (auth-Service)

`routes_selfhost_diagnose.py`: bei `inst.origin == 'app_host'` läuft vor die
Hostname-Kette die Telefonbuch-/Direktpfad-Prüfung; der STUN/RTMPS-Tail
entfällt. Neu: `dcc_auth/direktpfad_probe.py` (reine Rechnung +
async-Probe, pytest-geprüft wie `selfhost_probe.py`). Die UI
(`InstanceDiagnose.svelte`) rendert die Schritte generisch — keine Änderung
nötig.

## Stufe 2 — Server-App

Neuer Abschnitt „Verbindungen" in `server.html`: Knopf „Verbindung prüfen"
ruft über IPC **(a)** die lokalen Glieder (Runtime da, Container läuft,
Health am veröffentlichten Port, automatisches Backup vorhanden —
`lastAutoBackupAt`) und **(b)** dieselbe Cloud-Diagnose
(`POST /selfhost/diagnose/{id}` mit durablem Token) und rendert beide
Listen im InstanceDiagnose-Stil. Die Cloud-Kette wird NICHT im Desktop
nachimplementiert — ein Katalog bleibt im Server.

## Stufe 3 — später

Freund-Ansicht im Beitritts-Dialog: Direktpfad-Echtcheck (offer → direct-offer
→ ICE-State) + Voice-Probe aus dem Browser des Freundes; Muster steht in
`infra/self-host/tests/heim-ext-ice-probe.cjs`.
