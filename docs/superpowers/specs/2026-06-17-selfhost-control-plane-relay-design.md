# Design-Spec: Lokales Selfhosting — Sub-Projekt ②a „Steuerungs-Relay"

**Stand:** 2026-06-17 · **Status:** Design (vor Implementierungsplan) · **Scope:** nur ②a

## 1. Kontext & Ziel

Programm „Lokales Selfhosting" (Mittelstufe zwischen Cloud-Community und VPS): ein normaler User hostet
eine eigene Pulse-Instanz **vom eigenen Rechner aus** über die Desktop-App. **Sub-Projekt ①** (PR #20)
bringt den echten Backend-Stack Docker-frei lokal auf `localhost` hoch. **Sub-Projekt ②** löst die
**Erreichbarkeit**: wie kommen entfernte Mitglieder an eine Instanz auf einem Heim-Rechner hinter NAT?

② ist zweistufig (vom User bestätigt): **②a (diese Spec) = Steuerungs-Relay** — entfernte Mitglieder
können die Instanz erreichen, sich einloggen und **chatten** (Text/Presence). **②b** (eigene Spec) =
Medien direkt zum Host (Voice/Screenshare/HQ-Stream) + Port-Forward-Assistent.

## 2. Feste Constraints (vom User bestätigt)

1. **Cloud-Relay nur für die Steuerungsebene** (HTTP/WSS). Medien (②b) gehen **nie** über die Cloud.
2. **Stabiler Origin via Cloud-Subdomain** (Variante A): die Cloud vergibt pro Instanz
   `<instanz-id>.relay.howispulse.com` (Wildcard-TLS), Reverse-Tunnel zum Host. Diese Subdomain wird
   der stabile HTTPS-Origin des Hosts.
3. **Tunnel = etablierte selbst-hostbare Tech** (frp/rathole) auf der Pulse-Cloud (Pulse-betrieben,
   kein Dritter; kein Eigenbau-Tunnel).
4. **Identitäts-Plane bleibt cloud-direkt** — nur der host-seitige Teil (chat-gateway + dessen
   Cert-Login) läuft durch den Relay.

## 3. Das Problem (Befund der Code-Erkundung)

Heute ist **alles** an eine stabile `https://<hostname>`-Adresse gekoppelt: Client-Adressierung
(`server.hostname` als Basis-URL in `web/.../client.ts::buildUrl`) **und** Identität
(`JWT_ISSUER`, `WEBAUTHN_ORIGIN`/`rpId`, `CORS_ALLOW_ORIGINS`, Cert-Login-Origin — alle aus
`PULSE_HOSTNAME` in `infra/self-host/.../07-render-env.sh`). Ein Heim-Host **ohne Domain hat keinen
stabilen HTTPS-Origin** → bricht Auth *und* Adressierung. Es existiert heute kein Tunnel/Relay
(coturn ist nur Medien-NAT). ②a verschafft dem Host einen stabilen Origin über die Cloud-Subdomain.

## 4. Architektur — fünf Komponenten

1. **Cloud-Relay-Dienst (neu, Prod-Stack):** Tunnel-Server (frp/rathole) + Reverse-Proxy, der
   `<id>.relay.howispulse.com` → den Tunnel der Instanz → deren lokales chat-gateway durchreicht.
   **Wildcard-TLS `*.relay.howispulse.com`** (Cloud-verwaltet, z.B. Caddy via DNS-01). Terminiert TLS,
   leitet HTTP/WSS durch den Tunnel.
2. **Host-Tunnel-Client (gebündelt ins ①-Host-Modul):** kleiner frp/rathole-Client, **ausgehende**
   Verbindung zur Cloud, authentifiziert mit den Instanz-Credentials, registriert seine Subdomain.
   Läuft als weiterer überwachter Prozess im `LocalBackendManager` (aus ①).
3. **Origin/TLS-Umstellung am Host:** `PULSE_HOSTNAME = <id>.relay.howispulse.com`, TLS-Modus
   **„behind-proxy"** (Relay terminiert TLS, Host serviert lokal Plain-HTTP). → `JWT_ISSUER`,
   `WEBAUTHN_RP_ID/ORIGIN`, `CORS` zeigen auf die Subdomain → **stabiler Origin gelöst**, kein
   Let's Encrypt am Host.
4. **Cloud: Subdomain-Vergabe + Registry:** bei Approval/Bootstrap vergibt die Cloud die Subdomain +
   Tunnel-Credentials und speichert die Subdomain als Adresse der Instanz. Der **vorhandene
   Bootstrap-Token-Flow** wird erweitert, um Subdomain + Tunnel-Creds an den Host zu liefern.
5. **Client-Discovery:** der Client bekommt die Relay-Subdomain von der Cloud (Instanz-Liste/Cert/
   Server-Eintrag) → `server.hostname = https://<id>.relay…` → die **bestehende** `buildUrl`-Logik
   funktioniert unverändert.

## 5. Datenfluss & Auflösung der Origin-Kopplung

1. Host startet (①-Stack auf localhost) → Tunnel-Client verbindet ausgehend → Relay mappt die
   Subdomain auf den Tunnel.
2. Entferntes Mitglied bekommt die Subdomain von der Cloud → fügt sie als Server hinzu.
3. Client holt sein **Identitäts-Cert von der Cloud** (cloud-direkt, unverändert) → POSTet es an
   `…/api/chat/cert-login/challenge` **über die Subdomain** → Relay tunnelt → host-chat-gateway
   validiert (gegen Cloud-JWKS) → Challenge → Client signiert Nonce (Geräteschlüssel) → `/verify` →
   Host mintet **Session-Token** (EdDSA).
4. Danach: Chat-REST + **WS-Gateway** (`wss://<id>.relay…/ws?token=…`) durch den Relay zum Host →
   **Remote-Chat funktioniert.**

**Origin-Kopplung gelöst:** Session-Token-Issuer = Subdomain; `CORS_ALLOW_ORIGINS` = Cloud-Origin
(`howispulse.com`, schon drin) + Subdomain → die SPA (Cloud bzw. Electron-App) darf credentialed
gegen die Subdomain; WebAuthn-`rpId` = Subdomain (gültige Domain, vom Self-Host ungenutzt, aber
korrekt); Cert-Login-HMAC + Cloud-JWKS-Validierung sind origin-unabhängig.

**Was durch den Relay geht (②a):** nur `…/api/chat/*`, `/ws`, `…/api/chat/cert-login/*` →
host-chat-gateway. Die **Auth-Identitäts-Plane bleibt cloud-direkt**; der Relay muss die host-auth-svc
nicht exponieren. Medien-Pfade (`/livekit`, `/whep`) erst in ②b.

## 6. Fehlerbehandlung

- **Tunnel-Abriss:** frp/rathole-Client reconnectet mit Backoff; `LocalBackendManager` überwacht/
  restartet ihn. Getrennt → Relay liefert „offline" (502/503) → Client zeigt klare Meldung.
- **Host-App zu** → Tunnel weg → Subdomain offline (ephemer; UX-Feinheit = ③).
- **Relay (Cloud) unten** → Instanz unerreichbar; Relay-Dienst supervised im Prod-Stack.
- **Stale/Impersonation:** jeder Tunnel authentifiziert sich mit Instanz-Credentials; der Relay routet
  eine Subdomain nur zu *ihrem* authentifizierten Tunnel. **Suspendierte** Instanz (Registry-Status)
  → Relay verweigert den Tunnel.

## 7. Sicherheit (ehrlich benannt)

TLS am Cloud-Relay terminiert (Wildcard-Cert); der Tunnel Host↔Relay ist selbst authentifiziert/
verschlüsselt. **Konsequenz:** der Relay *sieht* die Steuerungs-Ebene im Transit — auch **Chat-
Inhalte** (gespeichert werden sie nur auf dem Host; der Relay leitet nur durch). Das ist der
inhärente Preis von „Relay" (Variante A). **Medien berühren die Cloud nie** (②b). Eine spätere
**Ende-zu-Ende-Verschlüsselung** der Nachrichten könnte das schließen — bewusst außerhalb ②a.

## 8. Tests

- **Integration:** Host (①-Stack) + **lokaler Relay** (frp/rathole-Server) + Tunnel-Client → Test-
  Subdomain/Port-Mapping → der Beitritts-Flow (Cert-Login challenge/verify mit Fixture-Cert/JWKS,
  Community anlegen, Nachricht) läuft **durch den Tunnel** end-to-end.
- **Reconnect:** Tunnel killen → Relay „offline" → Tunnel neu → wieder erreichbar.
- **Cloud-seitig:** Subdomain→Tunnel-Mapping + Wildcard-TLS (Test mit lokalem Cert).

## 9. Offene Detail-Entscheidungen (im Plan zu klären)

1. **frp vs rathole:** rathole (Rust, schlank, einfach) vs frp (Go, mehr Features). *Tendenz: rathole.*
2. **Wildcard-Cert-Provisionierung:** Caddy DNS-01 für `*.relay.howispulse.com` (braucht DNS-API-Zugriff
   beim Provider) vs. manuell hinterlegtes Wildcard-Cert.
3. **Subdomain-Schema:** `<instanz-id>` (Snowflake) vs. ein kürzerer Slug — Privacy/Lesbarkeit.
4. **Relay-Dienst-Platzierung:** eigener Container im Prod-Compose vs. in den bestehenden Caddy
   integriert.

## 10. Außerhalb des Scope von ②a

- **②b:** Medien direkt zum Host (LiveKit/MediaMTX-Signaling über die Subdomain, RTP direkt via ICE,
  UPnP + Port-Forward-Assistent).
- **③:** „App-zu → offline"-Lifecycle-UX, „Instanz hosten"-Knopf, Monetarisierungs-Gate.
- DNS-`*.relay`-Eintrag + Wildcard-Cert-**Provisionierung** ist Ops/Deploy (die Relay-Dienst-Config +
  -Code sind in-scope; das einmalige DNS/Cert-Setup ist ein dokumentierter Prerequisite).

## 11. Erfolgskriterien für ②a

Ein entferntes Mitglied kann über `https://<id>.relay.howispulse.com` (Reverse-Tunnel zum Heim-Host)
per Cert-Login beitreten, eine Community sehen/anlegen und Nachrichten senden/empfangen — der Host
hat keinen eigenen Domain/kein Let's Encrypt, alles läuft über die Cloud-Subdomain als stabilen
Origin; Medien-Traffic ist nicht Teil von ②a. Integrationstest beweist den Beitritts-/Chat-Flow durch
einen lokalen Tunnel + Reconnect-Resilienz.
