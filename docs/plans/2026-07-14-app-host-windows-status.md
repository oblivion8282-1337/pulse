# App-Host auf Windows/Mac — Stand & aufgeschobene Punkte (2026-07-14)

**Status:** Windows-App-Host läuft für **Chat/Communities/Admin** end-zu-end (live verifiziert
auf einer Windows-Box). HQ-Streaming und der größere Reachability-Umbau sind **bewusst
aufgeschoben** (User-Entscheidung 2026-07-14). Branch `feat/win-server-app-v2` — gepusht, **nicht**
nach main gemergt.

## Zwei Self-Hosting-Modelle (nicht verwechseln)
- **VPS-Self-Host** (`origin=vps`): eigener Linux-Server, echte öffentliche IP → alles nativ, läuft.
- **App-Host** (`origin=app_host`): Server-App startet lokal einen Container. Hinter Heim-NAT →
  Erreichbarkeit ist das schwierige Thema. Auf **Linux** nativ ok; auf **Windows/Mac** läuft der
  Container in einer **podman-machine-VM** — dort ist die ganze Härte.

## Was heute gefixt wurde (in diesem Branch)
Wurzel des Windows-Schmerzes: **rootless podman in der WSL-VM leitet eingehendes UDP nicht in den
Container** (TCP schon). Traf Direktpfad (7900), Voice, MediaMTX-WebRTC (8189).
- **`--network host`** im Win/Mac-Zweig (`containerBackendManager.ts`) statt `-p`-Publishing →
  Container bindet direkt auf der VM-Host-IP. Health-Check zielt dann auf `vmIp:8080`.
- **UDP-Relay** (`udpRelay.ts`) Host→VM für 7900 (Direktpfad) + **TCP-Relay** (`tcpRelay.ts`) für
  1936 (RTMPS). Der Windows/Mac-Host erreicht die VM-IP, der Browser klopft an die LAN-IP → Relay
  überbrückt. `ensureRelay()` startet beide.
- **direct-adapter LAN-Kandidaten-Injektion** (`infra/self-host/direct-adapter/src/sdp.rs`):
  `PULSE_DIRECT_EXTRA_HOST_IPS` (von der Server-App gerendert, `hostLanIpv4s()`) → der Adapter
  synthetisiert Host-Kandidaten für die LAN-IPs des VM-Hosts (sonst kandidatenlose Answer, weil
  der ip_filter die VM-internen 172.28.x verwirft).
- Ergebnis: Browser **und** nativer Client verbinden, Owner ist Admin (Cert-Login `user_id ==
  PULSE_INSTANCE_OWNER_ID`).

## Was NICHT läuft / aufgeschoben
1. **HQ-Streaming auf Windows-App-Host — kaputt, eigene Ursache.** Der win-hq-sidecar (ffmpeg-WHIP)
   scheitert beim **DTLS-Handshake mit Windows-Schannel**: `Creating security context failed
   (0x80090331 = SEC_E_ALGORITHM_MISMATCH)`. Schannel kann DTLS-SRTP nicht. **Kein Netzwerk-Problem
   und kein Relay-Fix hilft** (der Kontext wird gar nicht erst erzeugt). Auf Linux geht es, weil
   ffmpeg dort OpenSSL nutzt. Fix-Wege: (a) win-hq-sidecar-ffmpeg mit OpenSSL-DTLS bauen, ODER
   (b) den Owner auf **RTMPS** statt WHIP routen (RTMP hat kein DTLS) → der TCP-Relay (1936) trägt
   das schon; ABER die Owner-Exemption in `media-svc/routes.py` (`user_id == owner_id`) **greift auf
   Self-Host nicht**, weil sie die Cloud-Owner-ID mit dem Self-Host-pairwise_sub vergleicht, die nie
   matchen. → media-svc-Owner-Erkennung müsste gefixt werden.
2. **Voice aus dem LAN auf Win-App-Host** ist ungetestet — dieselbe UDP-Klasse, die LiveKit-Medien-
   ports sind aber NICHT ans Relay/LAN-Announce gehängt.
3. **Reachability-Grundsatz-Umbau aufgeschoben** (siehe unten).

## Reachability — Recherche-Fazit (deep-research 2026-07-14, adversarial verifiziert)
Idee war „Server-App wird lokaler Netz-Gateway" bzw. ein vorgebautes NAT-Traversal-Tool.
- **NetBird** ist der beste Einzel-Treffer: WireGuard-Mesh, native Win/Mac/Linux-Clients,
  **Pion-ICE-Lochung + Coturn/TURN-Relay-Fallback** (auch symm. NAT/CGNAT), **komplett selbst-hostbar**,
  Lizenz **BSD-3 Client / AGPLv3 Control-Plane** (passt zu uns). Würde den Eigenbau-Direktpfad **für
  native Clients** ersetzen.
- **Tailscale+Headscale**: ähnlich, aber DERP-Relay explizit „no throughput optimisations" → schlecht
  für HQ-Video; Win/Mac-GUI proprietär.
- **frp (haben wir schon)**: **XTCP** = ungenutzte STUN-Hole-Punching-Fähigkeit, Apache-2.0.
- **Killer-Haken:** **Browser können kein WireGuard** → ein Mesh löst nur native Clients; Browser
  brauchen weiter HTTP-Relay (frp-Subdomain) + TURN (coturn). Kein Tool deckt beides ab.
- **Universelle Erreichbarkeit = Relay/TURN** (teuer, Bandbreite); Direktpfad = billig aber
  NAT-abhängig. Zielbild bleibt **Hybrid** (billige Ebenen relayen, teure direkt, Relay-Fallback als
  bezahltes Cloud-Add-on — passt zum Monetarisierungsmodell).

**User-Entscheidung 2026-07-14:** „das ist es alles nicht, verkompliziert vieles" → App-Self-Hosting
noch aufschieben. Branch sichern statt mergen.

## Wenn wir wieder aufnehmen
1. Entscheiden: NetBird-Mesh (native) vs. frp-XTCP ausbauen vs. Eigenbau behalten.
2. Streaming: media-svc-Owner-Exemption für Self-Host fixen (→ RTMPS-Weg über den TCP-Relay) ODER
   sidecar-ffmpeg mit OpenSSL. Voice-LAN-Relay nachziehen, falls gewünscht.
3. Vor dem Merge: Changelog-Eintrag (Stil mit User), Bump ist schon auf 0.1.35, VPS-Feed
   `~/pulse/updates-win-server/` anlegen (Cloud-SSH steht jetzt).
