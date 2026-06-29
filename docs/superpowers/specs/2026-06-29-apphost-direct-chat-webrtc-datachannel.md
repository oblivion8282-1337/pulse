# Design-Konzept: App-Hosting — Chat & Uploads DIREKT (WebRTC-Datenkanal)

**Status:** Konzept / zurückgestellt (2026-06-29). Nicht gebaut. „Irgendwann gehen wir das an."
**Kontext:** Nachfolge-Idee zu `2026-06-17-selfhost-control-plane-relay-design.md` (②a Steuerungs-Relay)
und der real implementierten ②b (Medien direkt). Dieses Dokument beschreibt **②d: auch die
Steuerungs-Ebene (Chat + Uploads) direkt** — ohne den HTTP-Relay.

---

## 1. Ziel (in einem Satz)

Bei einem **app-gehosteten** Server sollen **Textnachrichten und Datei-Uploads direkt** zwischen
Mitglied und Heim-Gerät fließen — **so wie die Medien beim HQ-Streaming/Voice** —, statt durch den
Cloud-Relay (netcup). Nur die kleine Verbindungs-Aushandlung (Signaling) und die **Identität/Login**
(Cert-Modell) bleiben cloud-seitig. Persönliche DMs bleiben ohnehin Cloud (Identitäts-Plane).

**Nicht-Ziel:** VPS-Self-Hosts ändern. Die laufen schon komplett direkt (eigene Domain + Let's Encrypt
+ eigene MinIO; netcup nur für Identität). Dieses Konzept betrifft **ausschließlich App-Hosting**.

---

## 2. Wie es heute ist (verifiziert 2026-06-29)

App-Hosting startet einen **vollen nativen Stack auf dem Gerät** (kein Docker):
`desktop/electron/localBackend/` — postgres, redis, **minio**, auth, media-svc, mediamtx-auth-hook,
**chat-gateway**, voice-signaling, **eigener LiveKit**, **eigenes MediaMTX**, plus `frpc` (Tunnel-Client).

Zwei Transport-Welten:

- **Steuerungs-Ebene (HTTP/WSS) → über den Relay.** `frpc` tunnelt `/api/auth`, `/api/chat`, `/api/ws`,
  `/api/voice`, `/livekit`, `/whep`, `/hls` + Default `/` zur Heim-chat-gateway
  (`desktop/electron/localBackend/tunnel.ts:55-64`). Caddy am Relay terminiert TLS
  (`infra/prod/Caddyfile.pulse.snippet:44-51`) → **der Relay sieht Chat-Inhalte im Klartext im Transit**
  (eigene Aussage der Spec, `...relay-design.md:90-93`), speichert aber nichts.
- **Datei-Uploads → ebenfalls über den Relay.** Anhänge laufen per **presigned URL** direkt zur MinIO;
  deren öffentliche Adresse ist `S3_PUBLIC_ENDPOINT = https://<relay-subdomain>`
  (`desktop/electron/localBackend/renderConfig.ts:119`). → Die **Bild-Bytes transitieren netcup**
  (gespeichert wird lokal in der Geräte-MinIO).
- **Medien (Voice/Stream) → direkt.** Eigener LiveKit/MediaMTX auf dem Gerät; nur das **Signaling**
  läuft über den Relay (`/livekit`, `/whep`, `/hls`), die **Medien-Pakete (UDP/RTP) gehen direkt** zum
  Heim-Gerät — Ports werden per NAT-PMP am Heimrouter geöffnet (`localBackend/portMapper.ts`),
  öffentliche IP via STUN annonciert. Cloud ist im Medien-Pfad **nie** drin.

**Der Grund für die Asymmetrie:** Medien nutzen **WebRTC** (DTLS-selbstsigniert + ICE/NAT-Traversal) →
brauchen **kein browser-vertrautes TLS-Cert** → können direkt. Chat/Uploads nutzen **HTTPS** → brauchen
ein vertrautes Cert für die Adresse, mit der sich der Browser verbindet → ein Heim-Gerät mit wechselnder
IP ohne Domain kann das nicht → Relay liefert den stabilen, vertrauten HTTPS-Origin.

---

## 3. Die Idee: Chat/Uploads über einen WebRTC-Datenkanal

WebRTC kann nicht nur Audio/Video, sondern auch **`RTCDataChannel`** — verschlüsselte, direkte
Datenkanäle für beliebige Bytes. Damit lässt sich die **Steuerungs-Ebene genauso direkt** fahren wie
die Medien:

```
Mitglied (Browser)                          Heim-Gerät (App-Host)
  │                                              │
  │  1. Signaling (klein) ───über Relay/Cloud──► │   (SDP/ICE-Austausch + Host-Identität)
  │                                              │
  │  2. WebRTC-Datenkanal ════ DIREKT (DTLS) ═══ │   (NAT-PMP-Port, wie Medien)
  │         · Chat-Requests/Responses            │
  │         · Echtzeit-Event-Stream              │
  │         · Datei-Bytes (gechunkt)             │
  │                                              ▼
  │                                        „Chat-Daten-Brücke"
  │                                        DataChannel ↔ localhost
  │                                              │
  │                                        chat-gateway + MinIO (lokal)
```

- **Nur das Signaling** (winzig) streift Relay/Cloud — exakt wie das Medien-Signaling heute schon.
- **Chat-Text, Events UND Upload-Bytes** gehen **direkt** zum Heim-Gerät. netcup ist im Datenpfad **raus**.
- **Elegant:** löst das TLS-Cert-/DDNS-Problem **komplett**, weil WebRTC kein browser-vertrautes Cert
  braucht (DTLS-selbstsigniert; Vertrauen kommt über den signierten DTLS-Fingerprint im Signaling,
  gebunden an die Cloud-Identität/das Cert-Modell). Das ist der entscheidende Vorteil gegenüber dem
  „Mini-VPS"-Ansatz (DDNS + Let's Encrypt am Gerät), siehe §6.

---

## 4. Architektur-Skizze

### Host-Seite — „Chat-Daten-Brücke" (neue, eigenständige Komponente)
Wie HQ-Streaming ein eigenständiges Stück ist (GSR-Sidecar → MediaMTX), wäre dies ein eigenständiger
Prozess im `LocalBackendManager`-Stack:
- Nimmt WebRTC-Datenkanäle von Clients an (ICE/DTLS, NAT-PMP-Port wie die Medien).
- **Bridge:** übersetzt Datenkanal-Frames ↔ lokaler chat-gateway (HTTP auf `127.0.0.1` + die WS-`/api/ws`).
  Im Kern ein **„HTTP/WS over DataChannel"-Proxy**.
- Schreibt Upload-Bytes lokal in die MinIO (oder reicht sie an die presigned-PUT-Logik der lokalen MinIO
  weiter — dann ohne Relay).

### Client-Seite — Transport-Abstraktion
Heute baut das Frontend auf `fetch()` + `WebSocket` (`web/src/lib/api/*`, `web/src/lib/ws/`):
- Ein **zweiter Transport**: für app-gehostete Server Requests/WS/Uploads **über den Datenkanal**
  statt über HTTP. Idealerweise hinter der bestehenden `request()`/Gateway-Abstraktion versteckt,
  sodass die Aufrufer (Chat-Views etc.) unverändert bleiben.
- **Graceful Fallback:** wenn WebRTC nicht zustande kommt (CGNAT, §5) → automatisch zurück auf den
  HTTP-Relay (heutiger Pfad). Kein „kaputt", nur „dann eben über Relay".

### Signaling
- Reuse des Medien-Musters: ein kleiner Signaling-Endpoint (über den Relay/Cloud erreichbar) tauscht
  SDP/ICE-Kandidaten + den DTLS-Fingerprint des Hosts. Der Fingerprint muss an die **Cloud-Identität**
  gebunden/signiert sein, damit der Client sicher ist, mit dem richtigen Host zu sprechen (kein MITM).

---

## 5. Constraints & Risiken

- **CGNAT/striktes NAT:** identische Einschränkung wie bei den Medien — bei nicht erreichbarem Heimnetz
  geht der Direktpfad nicht → **Relay-Fallback** ist Pflicht (nicht optional).
- **„HTTP/WS nachbauen":** Request/Response-Framing, Multiplexing vieler paralleler Requests über einen
  Kanal, der Echtzeit-Event-Stream, **Datei-Chunking + Backpressure**, Reconnect, Reihenfolge/Reliability —
  all das, was HTTP/WS heute geschenkt liefern, muss über dem DataChannel sauber gebaut werden.
- **Sicherheit:** DTLS verschlüsselt den Kanal; der **Host-Fingerprint muss über die Cloud-Identität
  beglaubigt** sein (sonst MITM). Das ist der sensibelste Teil und muss zum Cert-Modell passen.
- **Performance:** DataChannel-Durchsatz für große Uploads testen (SCTP-Tuning, Chunk-Größe).
- **Komplexität/Wartung:** ein paralleler Transport-Layer ist dauerhafte Komplexität. Nur für
  App-Hosting; VPS + Cloud bleiben auf HTTP.
- **Browser-Support:** `RTCDataChannel` ist universell — unkritisch.

---

## 6. Alternativen (und warum dieser Weg)

| Ansatz | Direkt? | Cert-/DNS-Problem | Hinter jedem NAT? | Aufwand |
|---|---|---|---|---|
| **Status quo (Relay-HTTP)** | nein (über netcup) | gelöst (Cloud-Cert) | ✅ ja | — (gebaut) |
| **Mini-VPS-Direktmodus** (DDNS + Let's Encrypt + Port 443 am Gerät) | ja | **bleibt** (Cert/DNS am Gerät nötig) | ❌ nur ohne CGNAT | mittel |
| **TLS-Passthrough-Relay** (Relay reicht verschlüsselt durch) | **nein** (Bytes bleiben über netcup) | umgangen | ✅ ja | mittel |
| **WebRTC-Datenkanal (dieses Konzept)** | **ja** | **komplett umgangen** (DTLS) | ❌ nur ohne CGNAT (Fallback Relay) | **hoch** |
| **VPS-Self-Host** (Referenz) | ja, komplett | gelöst (eigene Domain) | n/a | — (gebaut) |

→ Der WebRTC-Datenkanal ist der **eleganteste** Weg zu „App-Hosting komplett direkt", weil er das
Cert-/DNS-Problem auflöst, das den Mini-VPS-Modus belastet — zum Preis eines neuen Transport-Layers.
„TLS-Passthrough" löst nur Privacy (Relay liest nicht mehr mit), **nicht** „nicht über netcup".

---

## 7. Grobe Aufwandsschätzung & Phasen (wenn wir es angehen)

1. **Spike/Machbarkeit:** ein nackter `RTCDataChannel` Browser ↔ Host-Bridge, der einen einzelnen
   chat-gateway-Request direkt durchreicht (inkl. NAT-PMP-Port + Signaling-Stub). Beweist den Kernpfad.
2. **Transport-Framing:** Request/Response-Multiplexing + WS-Event-Stream über den Kanal.
3. **Host-Brücke** als eigenständiger Prozess im `LocalBackendManager` (Lifecycle, Health, Restart).
4. **Client-Transport** hinter `request()`/Gateway, transparent für die Aufrufer + Relay-Fallback.
5. **Uploads** (Chunking/Backpressure) → lokale MinIO ohne Relay.
6. **Sicherheit:** Fingerprint-Beglaubigung über die Cloud-Identität; Reconnect/Resilienz; Tests.

**Größenordnung:** mehrere Wochen, eigener Transport-Layer. Kein „Schalter".

---

## 8. Relevante Dateien (Stand 2026-06-29, für den späteren Implementierer)

- `desktop/electron/localBackend/tunnel.ts` — heutige frpc-Pfade (was über den Relay läuft).
- `desktop/electron/localBackend/renderConfig.ts:119` — `S3_PUBLIC_ENDPOINT = https://<relay-subdomain>`
  (warum Uploads heute über netcup laufen).
- `desktop/electron/localBackend/media.ts` + `portMapper.ts` — wie die Medien WebRTC/ICE/NAT-PMP DIREKT
  machen (das Muster, das wir auf Chat übertragen).
- `web/src/lib/api/*` + `web/src/lib/ws/` — der heutige HTTP/WS-Transport, der einen zweiten Pfad bekäme.
- `docs/superpowers/specs/2026-06-17-selfhost-control-plane-relay-design.md` — das Relay-Grunddesign (②a/②b).
