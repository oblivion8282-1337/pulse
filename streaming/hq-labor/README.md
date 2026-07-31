# HQ-Labor — Messstand für den experimentellen Sendeweg

Ein **eigenes Artefakt**, kein Umbau des ausgelieferten Sidecars. Was hier
entsteht, heißt `pulse-hq-labor` und geht in keinen Nutzer-Build: das
Flatpak-Manifest baut ausschließlich `pulse-linux-hq-sidecar` aus
`streaming/linux-hq-sidecar/`, und dieses Verzeichnis hier wird von keinem
Workflow angefasst.

## Warum getrennt

Der experimentelle Weg (eigener WebRTC/WHIP-Push, AV1-Paketierer,
Intra-Refresh, FEC) ist kein Anbau, sondern greift mitten in den Sendepfad:
der Encoder-Ausgang wird von „schreib in den FLV-Muxer" zu einem Enum
`Muxer | Whip`, der Opus-Encoder wird für beide Wege gemeinsam geöffnet. Über
den ausgelieferten Stand gelegt, liefe **jeder Nutzer** durch diesen Code —
auch wer nie WHIP anfasst, und ein Fehler darin zeigte sich nicht als Absturz,
sondern als etwas mehr Ruckeln bei Leuten, die nichts damit zu tun haben.

Dazu kommt: der Weg funktioniert nur mit Beiwerk, das ebenfalls nicht
ausgeliefert ist — gepatchtes MediaMTX (siehe `mediamtx-patches/`), gepatchtes
`webrtc-rs` im Player, und der native Player selbst ist kein Produktteil.

## Wie die Trennung gebaut ist

Das Labor bindet den ausgelieferten Sidecar als **Bibliothek** ein
(`pulse-linux-hq-sidecar = { path = "../linux-hq-sidecar" }`) und kopiert nur
die Dateien, die der WHIP-Weg ohnehin umbaut:

| kopiert (weicht ab) | aus der Bibliothek (geteilt) |
|---|---|
| `encode/{mod,audio,mux_writer}.rs` | `capture/` (Portal, PipeWire) |
| `whip/{mod,av1,pacer}.rs` | `encode/{hw,nv_import,nv_p010,opts,raw_dump,va_import}.rs` |
| `ops/*`, `stream_controller.rs`, `dispatch.rs` | `caps`, `profiles`, `proto`, `events`, `logging`, `redact`, `system` |

Zwei Dinge daran sind nicht offensichtlich:

* **`ops/` und `stream_controller.rs` mussten zusammen mitkommen.** Läge `stop`
  in der Bibliothek und `start` hier, sprächen die beiden verschiedene
  Zustände an — der Stream ließe sich starten, aber nicht beenden.
* **Die Abhängigkeit läuft nur in eine Richtung.** Kein geteiltes Modul greift
  in die kopierten zurück (geprüft); die Bibliothek weiß vom Labor nichts.
  Deshalb kann `crate::capture::…` in den kopierten Dateien unverändert
  stehenbleiben — `lib.rs` re-exportiert die geteilten Module unter denselben
  Namen.

Der Preis ist die Duplikation dieser Dateien. Sie können auseinanderlaufen,
und das ist bewusst in Kauf genommen: erst wenn feststeht, welche Teile des
Messstands bleiben, lohnt es, eine saubere Naht (ein Trait „Paketsenke") in
die Bibliothek zu ziehen und die Kopien wieder aufzulösen.

**Der Preis ist sofort fällig geworden** — schon am Tag der Trennung hatte die
Bibliothek eine Signatur geändert (`opts::vendor_opts` nahm plötzlich den
Codec entgegen, aus der AMD-Encoder-Arbeit vom 2026-07-30), und die Kopie
brach. Der Compiler hat es gefangen, aber nicht jede Drift tut ihm den
Gefallen: eine geänderte **Konstante** in der Kopie fällt nicht auf, sie
verschiebt nur still die Messung.

**Beim nächsten Eingriff am ausgelieferten Sidecar deshalb abgleichen** —
mindestens die messrelevanten Werte. Stand 2026-07-31 geprüft und gleich:
`DEFAULT_INTERLEAVE_US = 10_000`; die Encoder-Optionen (`opts.rs`) teilt sich
das Labor ohnehin mit der Bibliothek, dort kann nichts auseinanderlaufen.

## Bauen und fahren

```bash
cd streaming/hq-labor && cargo build --release
```

Der Prüfstand (`streaming/testbench/`) nimmt das Labor-Binary von selbst, wenn
es gebaut ist; er meldet in jedem Lauf, welches Binary er fährt. Fehlt es,
fällt er auf den ausgelieferten Sidecar zurück — dann sind RTMPS-Läufe
weiterhin möglich, **WHIP-Läufe fallen aber still auf H.264 8 bit zurück**
(der ffmpeg-Muxer kann kein AV1). Genau das ist am 2026-07-30 unbemerkt
passiert, deshalb warnt der Prüfstand jetzt laut davor.

```bash
cd streaming/testbench
./ansehen.py --codec av1 --bits 10 --fps 60 --kbps 4000     # WHIP über Hetzner
./ansehen.py --proto rtmps ...                              # zum Vergleich der heutige Weg
```

## Der Server dahinter

Die Gegenstelle ist der Hetzner-Testserver, erreichbar als
`pulse.unicutmedia.com`. Seit 2026-07-31 läuft dort **nur noch MediaMTX**, als
eigenständiger Container `mediamtx-labor`:

```
~/mediamtx-labor/
  mediamtx              das gepatchte Binary (v1.19.1-dirty: PLI-Weiterleitung + FlexFEC)
  mediamtx.yml          Konfiguration, eingebaute Auth
  certs/                RTMPS-Zertifikat (self-signed, deshalb `tls_verify=0`)
  zugang.txt            Nutzer, Passwort, Lese-Token — chmod 600
  mediamtx.yml.original die Fassung aus dem alten All-in-one-Container
```

Vorher steckte dasselbe Binary **im** All-in-one-Container der
Self-Host-Testinstanz, der damit auch den Auth-Hook und eine Redis stellte.
Dieser Container ist entfernt (samt Volume, auf Wunsch), ebenso ein zweiter,
verwaister MediaMTX. Der pausierte Auto-Updater ist aus der Crontab raus — er
war nur pausiert, weil er sonst das getauschte Binary überschrieben hätte.

Drei Dinge, die man wissen muss:

* **Auth ist jetzt eingebaut, nicht mehr per Hook.** Ein Zugang (`labor`) darf
  senden und lesen; API und Metriken gehen ohne Zugangsdaten, aber nur vom Host
  (Port ist auf `127.0.0.1` gebunden). Der Prüfstand braucht damit **keinen
  Serverzugriff mehr** — vorher legte er für jeden Lauf zwei Token per `ssh` +
  `docker exec … redis-cli` in die Redis des Containers.
* **MediaMTX nimmt für WHEP ausschließlich Basic-Auth.** Zugangsdaten als
  Query-Parameter beantwortet 1.19.1 mit 401 (nachgemessen, nicht aus der Doku
  geglaubt). Unser Player kann keinen Auth-Header, deshalb **übersetzt Caddy**:
  es prüft den `?token=`, den Player und Prüfstand ohnehin mitschicken, und
  setzt den Header. Für alle Aufrufer sieht die Adresse aus wie vorher.
* **Das Bruecken-Netz dieses Servers ist `10.0.0.0/8`**, nicht der
  Docker-Standard `172.17.x`. Wer die IP-Liste in der `mediamtx.yml` nach
  Gefühl füllt, sperrt sich aus der eigenen API aus — die Antwort lautet dann
  `authentication error`, obwohl der Port gar nicht nach aussen zeigt.

Ein neues Patch-Binary einzuspielen ist ein Dateitausch:
`docker cp`/`scp` nach `~/mediamtx-labor/mediamtx`, dann
`docker restart mediamtx-labor`. Die Schalter (`PULSE_KEYFRAME_INTERVAL`,
`PULSE_FLEXFEC*`) stehen als Umgebungsvariablen am Container, nicht in der
`mediamtx.yml`.

## `mediamtx-patches/`

Die serverseitigen Stücke desselben Messstands, aus `infra/mediamtx-fork/`
hierher genommen:

* `0002-forward-viewer-keyframe-requests.patch` — leitet die Vollbild-Anforderung
  eines Zuschauers an den Publisher weiter (upstream wird sie verworfen) und
  macht die fest verdrahtete 2-Sekunden-Uhr über `PULSE_KEYFRAME_INTERVAL`
  abschaltbar.
* `0003-flexfec-on-whep.patch` — FlexFEC-03 auf dem WHEP-Ausgang
  (`PULSE_FLEXFEC=1`, Verhältnis über `PULSE_FLEXFEC_MEDIA`/`_FEC`).
* `0005-flexfec-nachlieferungen-nicht-puffern.patch` — **geht gegen
  vendorierten pion-Code, nicht gegen MediaMTX**, und muss deshalb nach
  `go mod vendor` angewandt werden. Ohne ihn zerstört jede NACK-Nachlieferung
  die Lückenlosigkeit des FEC-Puffers, `EncodeFec` gibt `nil` zurück, und die
  ganze Gruppe bleibt ungeschützt: bei 5 % Verlust kamen so nur 3200 statt
  16316 Paritätspakete zustande — der Schutz brach genau dann zusammen, wenn
  er gebraucht wurde. Die vollständige Bauanleitung steht im Patch-Kopf.

**Sie liegen hier, damit sie nicht ausgeliefert werden.** In
`infra/mediamtx-fork/patches/` würde jeder von ihnen beim nächsten `main`-Push
in dasselbe Image wandern, das Produktion pinnt. Der Testserver wird von Hand
versorgt; wenn einer davon bleiben soll, ist das eine bewusste Entscheidung
und ein Umzug zurück.
