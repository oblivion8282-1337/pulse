# Pulse Identity-Konzept — Hybrid aus Zentral + Selfhost

> **Status:** Kern-Architektur **entschieden am 2026-05-21** (Konzept festgehalten 2026-05-17).
> **Bau:** *nicht jetzt.* Erst Pulse als Single-Instanz stabil + Userbase — Voraussetzungen ganz unten.

## Die Idee in einem Satz

`pulse.com` ist deine **Identität** (ein Account für alles), die Server sind **isolierte Welten** mit eigenen Regeln/Ressourcen — das Minecraft-Modell für Chat + Voice.

## Drei Schichten

1. **Identität** (zentral, `pulse.com`)
   Dein „Pulse-Passport". Ein Account, der dich überall ausweist. Unabhängig davon, wo du chattest.

2. **Public-Tier-Server** (zentral, von uns gehostet)
   Wie Discord. Niedrige Einstiegshürde, jeder kann einen „Server" (= Guild) erstellen. Begrenzte Ressourcen (kein/wenig HQ-Streaming, kleine File-Uploads) — hält die Free-Tier-Hosting-Kosten im Rahmen.

3. **Self-Hosted-Server** (dezentral, von Usern)
   Volle Power. HQ-Streaming, massive Uploads, eigene Hardware = keine Limits.

## Warum das clever ist — das Henne-Ei-Problem

- Selfhost-only (Revolt, Rocket.Chat, Matrix): User müssen Server finden, Account machen, Freunde überreden → zu viel Reibung, nie kritische Masse.
- Zentral-only (Discord): User ist Geisel der Firma, kein Selfhost möglich.
- **Hybrid:** Einstieg so einfach wie Discord (auf `pulse.com` registrieren, fertig), Tür für Power-User trotzdem offen. Discord kann das nie anbieten — Selfhost killt ihr Geschäftsmodell. Pulse hat keins zu beschützen, also können wir beides.

## Was es *nicht* ist

**Keine Föderation.** Server reden nicht miteinander — kein ActivityPub, kein Matrix-Style-S2S-Protokoll. Es ist **Single Sign-On für Identität** + **isolierte Server** für Communities. Viel einfacher als Föderation, löst trotzdem ~80 % des Lock-in-Problems.

## Entscheidung: Mandatory SSO als Default (2026-05-21)

Von den zwei ursprünglich offenen Varianten (Optional vs. Mandatory SSO) ist es **Mandatory als Default** geworden:

- **Default — Mandatory:** Jeder User registriert sich auf `pulse.com`. Eine Identitätsquelle, keine Username-Konflikte, kein Mischsystem. Discord-leichtes, einheitliches Onboarding.
- **Escape-Hatch — `ALLOW_LOCAL_ACCOUNTS`-Flag:** Ein Selfhoster, der echtes Air-Gap *will*, aktiviert lokale Accounts per Config. Konsequenz: dieser Server hat kein SSO, keine Identitäts-Mobilität, nur manuelle Offline-Updates — eine versiegelte Welt. Der Lokale-Accounts-Pfad wird **einmal gebaut und deaktiviert geshippt** — kein Architektur-Fork, nur ein Schalter.

So ist „einheitlich" das Versprechen und „abgeschottet möglich" das Kleingedruckte — ohne dass man sich für eins entscheiden muss.

## Der Login-Flow (entschieden)

1. **User-Browser** authentifiziert bei `pulse.com` → signiertes JWT (RS256).
2. User reicht das JWT beim Selfhost-Server ein.
3. Server **validiert die Signatur offline** mit `pulse.com`s JWKS-Public-Key — gecacht, beim Install vorab einbaubar. **Kein Anruf bei `pulse.com`.**
4. Nach einmaliger Bestätigung mintet der Server **eigene** Session-/Refresh-Tokens. Ab dann: null `pulse.com`-Kontakt — Chat, Voice, Streaming, Reconnects laufen lokal.

`pulse.com` wird **nur 1× pro Login-Event** berührt — und zwar vom Browser, nicht vom Server. **Bonus:** `pulse.com` erfährt nicht, *welche* Selfhost-Server ein User nutzt.

**Zwei Token-Typen, nie verwechseln:** das `pulse.com`-JWT = Identitätsbeweis, einmal konsumiert und weggeworfen. Die server-eigenen Session-Tokens = laufender Betrieb. Pulse hat die Refresh-Rotation-Maschinerie (`auth-svc`) schon — der Selfhost-Server recycelt sie.

Das ist exakt das Auth0/„Sign in with Google"-Muster — und wie Pulse intern bereits arbeitet (`auth-svc` issued, `chat-gateway` validiert via JWKS).

**Identität reist mit dem User, nicht mit dem Server.** Ein Mensch kann mehrere Hüte tragen: eine `pulse.com`-Identität (reist überallhin) und/oder lokale Accounts auf `ALLOW_LOCAL_ACCOUNTS`-Servern (reisen nicht — eine versiegelte Welt ist versiegelt).

## Offene Designfrage: audience-binding vs. Privacy

Reicht der User sein `pulse.com`-JWT bei einem **bösartigen** Selfhost-Server ein, hält dieser ein gültiges Token in der Hand. Kann er es woanders einlösen — sich als der User ausgeben? Abwehr: das Token muss **`aud`-gebunden** sein, nur für genau diesen Server/Zweck gültig.

Aber: server-spezifisches `aud` zwingt den User, `pulse.com` beim Login den Zielserver zu nennen → `pulse.com` weiß es dann doch → **untergräbt die Privacy-Eigenschaft von oben.**

**Privacy vs. Replay-Schutz.** Threading-Optionen, noch offen: Bindung an den Server-Public-Key statt an einen geloggten Namen · DPoP-artige Proof-of-Possession · `pulse.com` bindet, behält aber kein Log. **Vor dem Bau zu klären.**

## Lizenz: AGPL-3.0 + Marke (2026-05-21)

Pulse hatte bisher **keine Lizenz** → de facto All Rights Reserved → die Selfhost-Story stand rechtlich auf Sand. Entschieden: **AGPL-3.0.**

- **Warum AGPL:** echtes Open Source (OSI-anerkannt, Selfhoster vertrauen dem), erlaubt Self-Hosting voll — das *ist* das Ziel — aber niemand kann Pulse closed-source übernehmen: jede über Netzwerk betriebene Modifikation muss offengelegt werden. Genau der Schutz gegen den closed-source-Konkurrenz-Fork.
- **Für diesen Produkttyp risikoarm:** die berüchtigte Firmen-Allergie gegen AGPL betrifft *Libraries*, die man linkt. Pulse ist eine Endnutzer-App, die niemand linkt. AGPL hält niemanden vom *Benutzen* ab.
- **Gilt auch für `pulse.com` selbst:** unsere Flagship-Instanz muss ihren Quellcode inkl. Modifikationen ihren Usern anbieten. Für ein ehrlich offenes Projekt = der Sinn der Sache.
- **Die Marke schützt den Namen — nicht die Code-Lizenz.** Ein Fork darf den AGPL-Code nehmen, sich aber nicht „Pulse" nennen / das Logo nutzen. Marke = der eigentliche Schutzwall (Mozilla/Firefox-, Mastodon-Modell). → Namen früh fixieren, einen *eintragbaren* (nicht „Pulse" — zu generisch).
- **CLA — entschieden 2026-05-21:** Ab Tag eins ein leichter Lizenz-*Grant*-CLA (Apache-ICLA-Stil, **keine** Copyright-Abtretung), per CLA-Assistant-Bot. Hält die Option auf **Dual-Licensing** offen (AGPL bleibt Primärlizenz für alle — der CLA *ergänzt* nur das Recht, zusätzlich eine bezahlte Kommerzlizenz anzubieten). Wirkt nicht rückwirkend → muss ab dem ersten externen PR aktiv sein. User ist aktuell solo / null Fremdbeiträge → jetzt einführen = lückenlose Deckung von Anfang an.
- **Vendored GSR behält seine eigene Lizenz:** `streaming/` ist eine vendored GPU-Screen-Recorder-Kopie — AGPL aufs Pulse-Repo relizenziert die *nicht*. GSR läuft als Subprozess-Sidecar = arm's length, kein Linking → keine Lizenz-Kontamination. Der Flatpak bündelt GSR, das ist „mere aggregation". Boundary in `LICENSE`/`README` klar dokumentieren.

**Nächste konkrete Schritte:** (1) ✅ `LICENSE` (AGPL-3.0) + `README.md` mit Copyright-Zeile, AGPL-Notice und GSR-Boundary-Note angelegt am 2026-05-21. Copyright-Halter: **Oblivion Pictures — Michael de Meyer**. (2) CLA-Assistant aufsetzen (Apache-ICLA-Stil) — vor dem ersten externen PR. (3) optional/später: SPDX-`license`-Felder in `package.json`/`pyproject.toml`, per-Datei-Header.

## Technische Skizze

Auth-Mechanik existiert eigentlich schon:

- Pulse hat **RS256-JWTs + JWKS-Endpoint** pro Instanz (`auth-svc`).
- Public Keys über JWKS abrufbar → Selfhost-Server validiert `pulse.com`-Tokens ohne Secret-Sharing.

Was ergänzt werden müsste:

1. **`pulse.com` als kanonischer Identity-Issuer** behandeln (bestehende Hosted-Instanz formal in die Rolle erheben).
2. **Selfhost-Server akzeptiert externe Identitäten:** `pulse.com`-JWT validieren (JWKS-Signaturcheck) → User mit `pulse.com`-Identität einloggen, Membership im lokalen Server vergeben.
3. **Globale Identität, lokale Autorisierung:** Der `pulse.com`-Account beweist *wer* du bist. Ob du einen Server *betreten* darfst, entscheidet der Server selbst — invite-gated. Sonst steht jeder Selfhost-Server allen `pulse.com`-Usern offen.
4. **Display-Identität:** auf `ALLOW_LOCAL_ACCOUNTS`-Servern lokaler User = `michael`, externer = `michael@pulse.com`. Im Mandatory-Default gibt es nur eine Quelle, kein Suffix nötig.
5. **JWT-Claims als einzufrierenden öffentlichen Vertrag** behandeln: `iss`/`ver`/`aud` früh einbauen — sobald fremde Server Tokens validieren, ist das Format eine API, die nie brechen darf (nur erweitern).

## Ehrliche Schwächen

- **SPOF `pulse.com`:** geht der Identity-Server runter, kann sich niemand *neu* einloggen. *Mitigation:* JWKS-Keys + laufende Sessions sind lokal gecacht (server-eigene Tokens) → bestehende Sessions laufen weiter, nur Neu-Logins blockieren.
- **Macht-Konzentration (durch Mandatory verschärft):** ein `pulse.com`-Bann = **globales Exil** aus *allen* SSO-Servern gleichzeitig. Im reinen Selfhost wär's nur ein Server. Bewusst akzeptiert. Einzige Insel: `ALLOW_LOCAL_ACCOUNTS`-Server.
- **Hosting-Kosten:** `pulse.com` kostet Geld, ohne Discords Nitro-Einnahmen. Free-Tier-Limits müssen die Kosten tragbar halten.
- **Username-Konflikte entfallen** durch Mandatory (eine Quelle, eindeutig) — sie treten nur noch in `ALLOW_LOCAL_ACCOUNTS`-Servern auf, dort lokal begrenzt.

## Vorbild: Minecraft

Genau dieses Modell, nur fürs Gaming:

- **Mojang-Account** = Identität, zentral.
- **Hypixel / 2b2t / Privatserver** = isolierte Welten mit eigenen Regeln.
- Login überall mit demselben Account, Name überall gleich, Inventory/Progress pro Server.

Das erfolgreichste Selfhost-Ökosystem der letzten 15 Jahre. Anmerkung: Minecraft selbst ist *nicht* Open Source — das Modell funktioniert auch proprietär. Pulse geht mit AGPL bewusst weiter, weil ein Solo-Maintainer einen Escape-Hatch fürs Ökosystem braucht (hört der Maintainer auf, können andere weitermachen).

## Nicht-Ziele

- Nachrichten zwischen Servern weiterleiten (= Föderation, nicht das hier).
- Voice/Streaming server-übergreifend (LiveKit/MediaMTX nicht dafür gebaut).
- Profil-Daten/Friends-Liste server-übergreifend syncen (evtl. V2; V1 = nur Identität).

## Wann anpacken?

**Nicht jetzt.** Voraussetzungen:

- Pulse läuft stabil als Single-Instanz.
- Userbase existiert (sonst löst der Identity-Layer ein theoretisches Problem).
- Selfhost-Workflow ist getestet + poliert (Docker-Compose-Stack hochziehen geht heute, ist aber nicht rund).

Bis dahin gilt nur: heutige Entscheidungen den künftigen SSO-Layer nicht blockieren lassen — JWKS-Endpoint öffentlich + stabil halten, JWT-Claims als einzufrierenden Vertrag behandeln (`iss`/`ver`/`aud` früh einbauen), Identitäts-Modell zukunftsoffen.

---

# Anhang: Erreichbarkeit & Traffic beim Self-Host (Brainstorm 2026-05-30)

Das obige Konzept klärt die **Identität** (wer der User ist → Cloud via SSO/Cert). Offen blieb die
**Netzwerk**-Seite: Wie kommt ein Heim-Server überhaupt erreichbar ins Netz, und wer trägt den Medien-Traffic?
Auslöser: Vision eines **„Ein-Klick → eigener Server"** in der Pulse-App (analog Discord-Server-anlegen / Minecraft-Realms).

## Warum ein Heim-Server nicht „einfach läuft"

Hardware ist fast egal — jeder Rechner, der durchläuft und Docker ausführt, reicht (Mac mini ideal, alter PC ok,
Raspberry Pi nur für Text-Chat; HQ-Streaming sprengt den Pi). Einziger HW-Stolperstein: **ARM vs. x86** — die GHCR-Images
müssten für ARM mitgebaut werden, sonst lokal bauen.

Der eigentliche Haken sind die **Browser**: Mikro/Kamera/Screenshare, Passkeys (WebAuthn) und PWA laufen nur über
**HTTPS**, und HTTPS braucht ein **Zertifikat auf einen Namen** (nicht auf eine nackte IP). Besonders hart bei Passkeys:
die rpId ist an einen Domain-Namen gebunden, eine IP kann gar nicht als Identität dienen (vgl. CLAUDE.md `WEBAUTHN_RP_ID`).
→ **Irgendein stabiler Name ist praktisch Pflicht**, sobald mehr als ein Gerät am selben Ort mitspielt. (`localhost`-Ausnahme
gilt nur same-machine; self-signed = rote Warnseite + Passkeys trotzdem kaputt.)

## Das Erreichbarkeits-Dreieck (nur 2 von 3)

Damit ein Heim-Server von außen erreichbar ist, müssen Daten reinkommen. Man kann nur **zwei** dieser drei Wünsche
gleichzeitig haben:

1. **Null Aufwand für den User** (kein Router-/Port-Gefummel)
2. **Null Traffic-Kosten für die Cloud** (läuft nicht über `howispulse.com`)
3. **Kein Fremd-Dienstleister** dazwischen

- **1 + 3** (bequem + niemand Drittes) → alles über die Cloud → **kostet die Cloud**. ❌ **Vom Owner explizit abgelehnt.**
- **2 + 3** (gratis + niemand Drittes) → User macht den Router selbst auf → **Aufwand kommt zurück**.
- **1 + 2** (bequem + gratis für uns) → **ein Dritter muss die Bytes tragen** (Tunnel-Dienst). ← der gewählte Pfad.

## Tunnel-Modell: Cloud *vermittelt*, transportiert nicht

Schlüssel-Unterscheidung: **Anruf vermitteln** ≠ **Gespräch durch die eigene Leitung schicken**. Ein „Tunnel" dreht die
Richtung um — der Heim-Server **ruft von sich aus** bei einer Vermittlung an und hält die Leitung offen (das darf jeder
Router, kein Port-Forwarding). Das löst Erreichbarkeit + Name + Zertifikat in einem.

**Owner-Constraint „keine Last/Kosten bei mir" → Variante:** Eure Cloud beschränkt sich auf **Identität + festen Namen**
(tut sie via Cert-Modell ohnehin, ein paar Bytes pro Login). Den **fetten Medien-Transport** übernimmt ein **kostenloser
Tunnel-Dienst, den der Self-Hoster selbst nutzt** (z. B. Cloudflare Tunnel / Tailscale Funnel) — deren Infrastruktur trägt
die Bandbreite, nicht wir. Tunnel-Client analog zum GSR-Sidecar in die Electron-App einbetten → Ein-Klick-Connect.

**Nebeneffekt (gut):** Self-Hosts werden dadurch echt unabhängig — fällt die Cloud aus, laufen sie weiter (Daten flossen
nie durch uns). Passt zum Minecraft-Vorbild (Mojang trägt keinen Server-Traffic).

**Ehrliche Haken:** (a) Fremd-Dienst-Abhängigkeit + dessen Gratis-Grenzen (für Freundeskreis ok, Dauer-HD-Publikum stößt an);
(b) **Name muss stabil sein** (sonst brechen Passkeys) → die „benannte" Tunnel-Variante, nicht die Wegwerf-Zufallsnamen;
(c) Rechner muss anbleiben; (d) Heim-Upload bremst Voice/Streaming (Physik, kein Bug).

## Medien-Topologie: wer trägt die Vervielfältigung?

Alle drei Modelle halten Traffic **von der Cloud fern** — sie unterscheiden sich nur, auf wessen Schultern die Last landet.
Bild: jeder im Channel hat ein „Dokument" (Stream), das alle anderen bekommen sollen.

1. **P2P / Mesh** — jeder kopiert direkt an jeden. Top bei 2–3 Leuten (DM-Voice!), bricht bei vielen zusammen
   (man lädt N-mal hoch); ~20 % der Paare brauchen wegen NAT doch einen TURN-Relay.
2. **Host = Relay (SFU)** — **das ist das heutige Self-Host-Modell** (LiveKit/MediaMTX auf der Owner-Maschine). Sender lädt
   1× hoch, der **Host** vervielfältigt N-fach → sein Upload ist die Decke. Die „Heim-Upload-Bremse" *ist* dieses Modell.
3. **Dynamisch aufgeteiltes Relay (Schwarm/Baum)** — Last verteilt sich auf die Teilnehmer (s.u.).

**Schlüssel-Erkenntnis — Voice ≠ Streaming trennen:**
- **Voice ist winzig** (~40 kbit/s) → Host-Relay (Modell 2) reicht selbst für 10 Leute locker. **Nichts kaputt, nichts tun.**
- **HQ-Video ist der Brocken** und **einseitiger Broadcast** → nur *hier* lohnt Modell 3, und Latenz ist hier unkritisch.

→ Saubere Architektur: **Voice bleibt Host-Relay; nur fürs HQ-Streaming kommt ggf. Peer-Verteilung dazu.** Pures P2P
höchstens als Turbo für 1:1-DM-Voice.

## Modell 3 im Detail — wie Peer-Verteilung funktioniert

**Kern-Trick:** nicht den *lebenden Strom* peer-to-peer weiterleiten (brutal schwer/fragil = Forschung), sondern den Stream
in **nummerierte Häppchen** zerschneiden (HLS — kann MediaMTX schon) und diese wie Sammelkarten herumreichen.

**Preis:** ein paar Sekunden Verzögerung (Häppchen muss fertig sein, bevor es weiterwandert). Für „schau mir beim Zocken zu"
egal (Twitch: 10–20 s), für Gespräche Gift → **deshalb nur Broadcast, nie Voice**.

**Bausteine:** (1) Zerschneiden (HLS). (2) **Schwarm** (BitTorrent-Prinzip: jeder zieht von mehreren Nachbarn, selbstheilend)
statt fragilem Baum. (3) **Vermittler/Adressbuch** — sagt Peers, wer frische Häppchen hat, fädelt den WebRTC-Handshake ein;
**winzig, nur Signaling, kein Video** → könnte Cloud *oder* Host machen, kostet quasi nichts. (4) **Sicherheitsnetz:** fehlt ein
Häppchen rechtzeitig, holt der Peer es **direkt vom Host** → fällt sanft auf Modell 2 zurück, kann nie ganz brechen.
(5) NAT-Haken wie bei P2P.

**Effekt:** 20 Zuschauer → Host schickt jedes Häppchen nur an 2–3, die reichen weiter → Host lädt **2–3×** statt **20×** hoch.
Last wächst *nicht* mit der Zuschauerzahl.

## Recherche-Ergebnis: fertige Bausteine existieren (Stand 2026-05-30)

Muss man **nicht bauen, nur einbinden**:

- **Novage `p2p-media-loader`** (klarer Gewinner) — v2.3.1 vom **2026-05-10** (aktiv gepflegt), ~1.7k Sterne,
  **Apache-2.0** (AGPL-kompatibel), HLS + DASH, hls.js/Shaka, **Live + VOD**, minimale Server-Infra (öffentliche
  WebTorrent-Tracker + STUN default; eigener Tracker = Mini-Signaling-Dienst, **kein** Video). Werbung: bis zu **80 %**
  weniger Quell-Bandbreite. Kein Low-Latency (= das Häppchen-Delay oben).
  <https://github.com/Novage/p2p-media-loader>
- **Bester Praxis-Beweis: PeerTube** (philosophischer Zwilling — föderiert, self-hostbar, AGPL) nutzt genau diese Lib
  produktiv für Video *und* Live. <https://github.com/Chocobozzz/PeerTube/pull/3250>
- Alternativen verworfen: *BemTV* (verwaist), *cdnbye* (kommerziell), *p2p-hls* (kleiner).

**Integrations-Konsequenz:** **kein Ersatz** für das heutige sub-sekunden-WHEP, sondern **zweiter Streaming-Modus**
(„Großes Publikum, leicht verzögert" ↔ „Kleine Runde, sofort"). Anderer Browser-Player (hls.js statt handgebautem WHEP-Client).

## Fazit & Wann anpacken

- **Tunnel (Cloud vermittelt, Dritter transportiert):** der gangbare Weg für „Ein-Klick-Self-Host ohne Kosten bei uns".
  Fehlende Stücke: Tunnel-Vermittlung-Anbindung + Start-Knopf in der App. Mittelfristig, sobald Self-Host-Workflow poliert wird.
- **Modell 3 / `p2p-media-loader`:** real, reif, lizenz-kompatibel, durch PeerTube bewiesen — **aber Medizin gegen *viele
  gleichzeitige Zuschauer***, die ein Freundeskreis-Self-Host nie erreicht. **Option für „falls Pulse groß wird / öffentliche
  Streamer", kein To-do für jetzt.**
