# Lokaler Dev-Stack auf macOS

Gilt zusätzlich zu `scripts/dev-up.fish`. Alles hier dreht sich um **einen**
Unterschied, aus dem drei Folgen entstehen.

## Der Unterschied

LiveKit und MediaMTX laufen im Dev-Stack mit `network_mode: host`. Auf Linux
ist das der Rechner selbst. **Auf Docker Desktop für macOS ist es die
Linux-VM** — ein anderer Rechner:

- Kein Port ist vom Mac aus offen. `curl http://localhost:7880` schlägt fehl,
  obwohl `docker ps` den Container als „Up" zeigt.
- Beide Dienste sagen ihre VM-interne Adresse (`192.168.65.x`) als
  Verbindungsziel für WebRTC an. Selbst wenn man die Ports erreicht, findet
  kein Medienstrom den Weg zurück.

Das sieht nach einem Fehler der Anwendung aus. Der Sprachkanal meldet
`could not establish signal connection: Failed to fetch`, Übertragungen
bleiben schwarz — und im Container-Log steht nichts Auffälliges.

Dieselbe Einschränkung gilt auf Windows; dort umgeht sie `pnpm dev:local`,
indem beide Dienste **nativ** statt im Container laufen.

## Die Lösung

Zwei Compose-Aufsätze ersetzen Host-Networking durch veröffentlichte Ports
(nur auf `127.0.0.1` — der Stack soll nicht im WLAN stehen) und mounten je
eine angepasste Konfiguration:

    # LiveKit
    docker compose -f docker-compose.yml -f docker-compose.mac.yml \
      --profile voice up -d livekit

    # MediaMTX (eigenes Compose-Projekt)
    cd streaming/server
    docker compose -f docker-compose.yml -f docker-compose.mac.yml up -d mediamtx

Die beiden Konfigurationen (`infra/livekit/livekit.mac.yaml`,
`streaming/server/mediamtx.mac.yml`) unterscheiden sich von ihren Vorlagen an
genau drei Punkten, jeder am Ort begründet:

1. **ICE-Ansage auf `127.0.0.1`** (LiveKit `node_ip`; MediaMTX hat
   `webrtcAdditionalHosts` schon richtig stehen).
2. **Webhook/Auth-Adresse auf `host.docker.internal`** statt `localhost` — im
   Bridge-Netz ist `localhost` der Container selbst. Ohne das kommen bei
   LiveKit keine Anwesenheits-Meldungen an, und MediaMTX weist **jede**
   Veröffentlichung und jedes Zuschauen ab.
3. **MediaMTX-API auf allen Schnittstellen** (`:9997` statt
   `127.0.0.1:9997`), sonst erreicht die Port-Veröffentlichung sie nicht.
   Nach aussen bleibt sie trotzdem auf `127.0.0.1` gebunden.

## Das Fork-Image

MediaMTX läuft als Pulse-Fork (sieben Patches). GHCR verlangt eine Anmeldung;
ohne sie endet der Pull mit **403**. Selbst bauen:

    docker build -t ghcr.io/oblivion8282-1337/pulse-mediamtx:1.19.1-pulse8 \
      infra/mediamtx-fork

Dauert ein paar Minuten — die Patches und die Go-Tests des Forks laufen mit;
ein nicht aufgehender Patch bricht den Bau ab, ein grüner Bau ist also der
Beleg.

**Dem Tag nicht glauben**, sondern nachsehen:

    docker logs streaming-mediamtx | head -1

Dort muss `v1.19.1-dirty` stehen. „dirty" ist hier das Gütesiegel — es heisst,
dass die Patches im Baum sind. Ein sauberes `v1.19.1` wäre der Upstream, und
dem fehlen Vollbild-Rückweg, Bildmarke, Vollbild-nach-Verwurf und FlexFEC.

## FlexFEC: hier AN, in der Haupt-Datei AUS

Der macOS-Aufsatz fährt den **Produktionssatz** aller acht `PULSE_*`-Schalter
(Eigentümer-Entscheid 2026-10-08) — dieser Stack soll nachstellen, was Nutzer
erleben.

Die Haupt-Datei lässt FlexFEC bewusst aus, und der Grund gilt weiter: bei der
Fehlersuche laufen sonst zwei Verlust-Maßnahmen gleichzeitig, und keine ist
mehr zuzuordnen. **Wer einem konkreten Bildfehler nachgeht, schaltet FlexFEC
für den Durchgang ab.**

## Was auch damit nicht geht

**Voice und Streaming von einem zweiten Gerät** (Handy im WLAN) gegen diesen
Stack. Alles hängt an der Loopback-Adresse, und voice-signaling reicht den
Klienten `ws://localhost:7880`. Für ein zweites Gerät bräuchte es die
LAN-Adresse — dagegen steht der Riegel in voice-signaling, der mit den
Repo-Dev-Schlüsseln keine nicht-lokale URL annimmt.

Fürs Testen über mehrere Geräte bleibt der Remote-Dev-Stack
(`infra/dev-remote/README.md`).
