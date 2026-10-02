# HQ-Labor — Messstand für den experimentellen Sendeweg

> **Intra-Refresh ist am 2026-08-21 aus Pulse entfernt worden.** Die
> Betriebsart, um die es auf diesem Blatt streckenweise geht, gibt es nicht
> mehr: kein Kästchen, kein Health-Feld, keine Encoder-Optionen, keine
> FFmpeg-Patches. Gründe waren das sichtbar schlechtere H.264-Bild, dass macOS
> sie nie trug, und dass ein Vollbild-Strom sich nach Paketverlust selbst
> repariert — ein Intra-Refresh-Strom nicht. Die zugehörigen Messakten sind
> gelöscht, weil sie teils nie bestätigt und teils später widerlegt wurden.
>
> **Was hier über die Betriebsart steht, ist Historie und keine Anleitung.**
> Methodik, Aufbau und alles Übrige gelten weiter.


Ein **eigenes Artefakt**, kein Umbau des ausgelieferten Sidecars. Was hier
entsteht, heißt `pulse-hq-labor` und geht in keinen Nutzer-Build: das
Flatpak-Manifest baut ausschließlich `pulse-linux-hq-sidecar` aus
`streaming/linux-hq-sidecar/`, und dieses Verzeichnis hier wird von keinem
Workflow angefasst.

## Warum getrennt

Der experimentelle Weg (eigener WebRTC/WHIP-Push, AV1-Paketierer, FEC — und
bis zum 2026-08-21 Intra-Refresh) ist kein Anbau, sondern greift mitten in den
Sendepfad:
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
(`pulse-linux-hq-sidecar = { path = "../linux-hq-sidecar" }`). **Seit dem
2026-08-02 hat es keinen eigenen Sendepfad mehr**: `src/` besteht nur noch aus
`lib.rs` und `main.rs`, und `lib.rs` re-exportiert die geteilten Module
(`caps`, `capture`, `dispatch`, `encode`, `events`, `logging`, `ops`,
`profiles`, `proto`, `redact`, `stream_controller`, `system`, `whip`). Läuft
das Binary, fährt es exakt denselben Code wie ein Nutzer; der eigene
WebRTC-Sendeweg mit AV1-Paketierer und RTCP-Rückkanal, der hier entstanden ist,
liegt im ausgelieferten Sidecar nebenan.

Geblieben ist der Ort für Versuche, die im Produkt nichts verloren haben —
Diagnosezähler, Messschalter, Varianten, die noch nicht entschieden sind. Was
hier gemessen und für gut befunden wurde, wandert nach nebenan, nicht
umgekehrt. (Bis zum 2026-08-02 kopierte das Labor die Dateien, die der WHIP-Weg
umbaute, und nahm deren Duplikation bewusst in Kauf; die Kopien sind mit dem
Zusammenschrumpfen auf Re-Exporte aufgelöst.)

## Bauen und fahren

```bash
cd streaming/hq-labor && cargo build --release
```

Der Prüfstand (`streaming/testbench/`) nimmt das Labor-Binary von selbst, wenn
es gebaut ist; er meldet in jedem Lauf, welches Binary er fährt. Fehlt es,
fällt er auf den ausgelieferten Sidecar zurück — das schränkt heute nichts
Wesentliches ein: der eigene WebRTC-Sendeweg mit AV1-Paketierer liegt seit dem
2026-08-02 im ausgelieferten Sidecar (`encode::create_whip`, `src/whip/`), es
gibt also weder einen ffmpeg-Muxer-Weg noch einen stillen AV1-Rückfall auf
H.264 8 bit mehr. (Am 2026-07-30, als das Labor der einzige Träger des
WHIP-Wegs war, ist genau dieser Abfall unbemerkt eingetreten — die
Binary-Meldung in jedem Lauf stammt aus dieser Zeit.)

```bash
cd streaming/testbench
./ansehen.py --codec av1 --bits 10 --fps 60 --kbps 4000     # WHIP über Hetzner
./ansehen.py --proto rtmps ...                              # zum Vergleich der heutige Weg
```

## Der Server dahinter

Die Gegenstelle war der Hetzner-Testserver, erreichbar als
`pulse.unicutmedia.com`. Von 2026-07-31 an lief dort **nur noch MediaMTX**, als
eigenständiger Container `mediamtx-labor`:

> **Der Messstand ist seit dem 2026-08-12 gestoppt** — dieselbe Adresse trägt
> seither den gemeinsamen Remote-Dev-Stack. Ein Lauf dagegen endet in HTTP 401.
> Die Rückholanleitung liegt auf dem Server (`~/messstand-gestoppt-2026-08-12.txt`);
> was hier folgt, beschreibt den Aufbau, wie er dann wieder entsteht.


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
* `0004-flexfec-adaptiv.patch` — bezahlt die Parität nur, wenn die Leitung sie
  braucht (`PULSE_FLEXFEC_ADAPTIV=1`). **Regelgröße ist der eingehende NACK,
  nicht `fraction lost`** — der reagiert erst auf eingetretenen Schaden, und
  feiner als 0,39 Prozent lässt sich die Schwelle gar nicht stellen (8-Bit-Wert).
  Am 2026-08-04 neu gefasst; auf sauberer Leitung 20,01 → 0,65 Prozent
  Aufschlag bei identischem Bild. Fehlte in dieser Aufzählung bis 2026-08-04,
  obwohl es den Patch seit dem 2026-07-31 gibt.
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
