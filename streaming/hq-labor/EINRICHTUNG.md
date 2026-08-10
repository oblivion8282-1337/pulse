# Labor auf einem neuen Rechner einrichten

Was auf dieser Maschine steht, steht nicht automatisch auf der nächsten. Zwei
Dinge sind bewusst **nicht** im Repo und müssen hergestellt werden, ein drittes
liegt auf dem Server.

## 1. Branches holen

Die Laborarbeit liegt auf zwei Zweigen, nicht auf `main`:

```bash
git fetch origin
git checkout werkzeug/pruefstand-labor-server   # Prüfstand, Messwerkzeuge, Messakten
git checkout feat/native-hq-player              # nativer Player
```

**Sie hängen zusammen, liegen aber getrennt** — der Player braucht den
Prüfstand zum Messen, der Prüfstand den Player als Zuschauer. Beim Arbeiten
heißt das: nicht den Zweig wechseln, während eine Messung läuft. Am 2026-07-31
sind so fünf von sechs Läufen einer Kennlinie ausgefallen, weil mitten im Lauf
die Prüfstand-Skripte verschwanden.

## 2. Den gepatchten webrtc-rs herstellen

`streaming/pulse-player/vendor/` ist in `.gitignore` und **fehlt nach dem
Klonen**. Ohne ihn bricht schon `cargo build` beim Auflösen der Abhängigkeiten
ab, weil `Cargo.toml` über `[patch.crates-io]` dorthin zeigt.

```bash
cd streaming/pulse-player
bash scripts/bootstrap-webrtc.sh    # klont v0.17.2, wendet patches/*.patch an
cargo build --release
cargo test --release                # muss grün sein (254 Tests, Stand 2026-08-10)
```

**Nicht nur nach dem Klonen — auch nach jedem `git pull`, der `patches/`
anfasst.** Der Vendor-Baum ist ignoriert, also merkt git nicht, dass er
veraltet ist: ein neuer Patch liegt dann im Repo, aber nicht im Baum, und
`cargo build` läuft stillschweigend gegen den ungepatchten Stand weiter. Am
2026-08-10 genau so passiert — `0003` fehlte, der zugehörige Test fiel um, und
der Ausfall sah zunächst nach einem Fehler des gerade bearbeiteten Themas aus
(einer wgpu-Migration, mit der er nichts zu tun hatte). Die teurere Richtung
desselben Fehlers: den Ausfall dem eigenen Zweig zuschreiben und ihn
„wegreparieren", statt den Baum herzustellen.

Das Skript wendet **alle** Patches aus `patches/` an. Drei sind es derzeit:

* `0001-…-expose-undeclared-ssrc-streams` — nötig, damit der Paritätsstrom
  überhaupt sichtbar wird (er trägt eine eigene, im SDP nicht angekündigte
  Quellkennung).
* `0002-nack-generator-resend-delay` — die NACK-Sperrfrist, ohne die dieselbe
  Lücke sechs- bis achtmal angefordert wird.
* `0003-h264-stapa-bounds-check` — Grenzprüfung im STAP-A-Entpacker. Die
  Schleifenbedingung sichert **ein** lesbares Byte zu, die Größenangabe ist
  aber zwei Byte lang; ein STAP-A-Paket mit einem einzelnen überzähligen Byte
  liest darüber hinaus und bringt den Player zum Absturz. Das ist ungeprüfter
  RTP-Inhalt, also **aus der Ferne auslösbar** — der Patch ist kein
  Schönheitsfehler, und ein Player aus einem ungepatchten Baum trägt die Lücke.

## 3. Den Messstand bauen

```bash
cd streaming/hq-labor && cargo build --release
```

Das ist der Sender mit dem eigenen WHIP-Weg. Ohne ihn fällt `real-harness.py`
auf den ausgelieferten Sidecar zurück, und WHIP-Läufe landen still bei H.264.

## 4. Zugang zum Labor-Server

Die Zugangsdaten stehen **auf dem Server**, nicht im Repo:

```bash
ssh michael@77.42.71.166 'cat ~/mediamtx-labor/zugang.txt'
```

Daraus werden drei Variablen gesetzt (`user`, `pass`, `lese_token`):

```bash
export PULSE_FERN_USER=…  PULSE_FERN_PASS=…  PULSE_FERN_TOKEN=…
```

Ohne sie bricht jeder Fernlauf sofort mit „PULSE_FERN_PASS fehlt" ab.

Die Betriebsart des Servers stellt `~/mediamtx-labor/neustart.sh` um; ohne
Argumente ist es die Vorgabe (FlexFEC 10+2, Intra-Refresh). **Der Server ist
gemeinsam** — wer ihn umstellt, stellt ihn für alle um, und wer eine Messreihe
fährt, sollte ihn danach zurückstellen.

**Seit 2026-08-04 läuft dort das ausgelieferte Image**, nicht mehr ein von Hand
hochgeladenes Binary. Vorher lagen unter `~/mediamtx-labor/` mehrere Dateien
(`mediamtx`, `.fecfix`, `.adaptiv`, `.diag`, `.vor-*`), deren Inhalt nirgends
stand — der Dateiname war die ganze Dokumentation, und ob der gemessene Stand
dem entspricht, was in die Produktion geht, war nicht belegbar. Jetzt ist es
exakt das Image aus `infra/mediamtx-fork/` (Patches 0001–0005), dasselbe, das
der Dev-Stack fährt. Neu einspielen von der Entwicklungsmaschine:

```bash
docker build -t pulse-mediamtx:1.19.1-pulse2 infra/mediamtx-fork/
docker save pulse-mediamtx:1.19.1-pulse2 | gzip | ssh pulse-test 'gunzip | docker load'
ssh pulse-test 'docker tag localhost/pulse-mediamtx:1.19.1-pulse2 pulse-mediamtx:1.19.1-pulse2'
```

Das `localhost/`-Präfix entsteht, weil die Entwicklungsmaschine podman fährt
und dessen `save` den Namen voll qualifiziert; ohne das Nachtaggen sucht Docker
auf dem Server eine Registry und scheitert mit „pull access denied". Der
Rückweg auf das alte Binary liegt als `neustart.sh.binary-alt` daneben.

**Die Quelle von `neustart.sh` liegt im Repo**, unter
`streaming/hq-labor/labor-server/neustart.sh`. Bis zum 2026-08-04 existierte
das Skript *nur* auf dem Server — bei einem Neuaufsetzen wäre es weg gewesen,
und niemand hätte gewusst, wie der Laborserver eigentlich gestartet wird.
Ändert man es, gehören beide Stände nachgezogen:

```bash
scp streaming/hq-labor/labor-server/neustart.sh pulse-test:~/mediamtx-labor/neustart.sh
```

Das Beistell-Image für die Störstrecke (`pulse-tc:1`, alpine mit `iproute2`)
muss **nicht** von Hand angelegt werden — `streaming/testbench/serverstoerung.py`
baut es beim ersten Bedarf selbst.

**`ssh` braucht dort einen Namen, keine IP.** Die Vorgabe `michael@77.42.71.166`
findet den Schlüssel nur, wenn er in `~/.ssh/config` an dieser Adresse hängt;
steht er unter `Host pulse-test`, fragt ssh nach einem Passwort und ein
Messlauf wartet stumm bis zum Zeitablauf. Deshalb `export
PULSE_FERN_SSH=pulse-test`.

## 5. Was das System braucht

* **Rust** (stable), **ffmpeg** mit `av1_nvenc` bzw. `av1_vaapi`/`av1_amf`
* **Python 3.13**, `uv` (für `uvx ruff`)
* `sudo` ohne Passwort für `tc` und `tcpdump` — sonst laufen `verluststrecke.py`
  und jede Mitschnitt-Auswertung nicht
* Kernel-Module `ifb`, `sch_netem`, `act_mirred` (für die Teststrecke)
* **`libva-dev`** — nur für `testbench/vaapi-intra-refresh-pruefen.c`, das auf
  AMD-Maschinen klärt, ob die GPU Intra-Refresh kann

## 6. Erster Lauf zur Kontrolle

```bash
cd streaming/testbench
python3 verluststrecke.py --status          # muss "ingress: (keine)" zeigen
PULSE_PLAYER_FLEXFEC=1 python3 intraref-verlust.py --secs 60 --label probe
```

Danach steht `probe.json` da. Die Kontrollzahlen: `nack_deckt_lauf_ab` muss
`true` sein, `anzahl_ssrcs` genau 2 (Bild und Parität).

## Was auf einer AMD-Maschine zuerst zu tun ist

**Die Frage „kann AMD Intra-Refresh?" ist beantwortet: ja** (2026-08-01,
Radeon 780M/VCN 4, Mesa 26.1.5 — Messakte
`testbench/profiles/amd-2026-08-01-intra-refresh.json`). Auf einer anderen
AMD-Karte lohnt die Gegenprobe trotzdem, sie dauert eine Minute:

```bash
cd streaming/testbench
cc -o /tmp/vaapi-ir vaapi-intra-refresh-pruefen.c -lva -lva-drm
/tmp/vaapi-ir
```

Im Weg steht nicht die Hardware, sondern **FFmpeg** — es reicht die
VA-API-Schnittstelle in keiner Version durch. Für Intra-Refresh auf AMD
braucht diese Maschine also ein gepatchtes FFmpeg:

```bash
# Patch, Bauanleitung und Begründung:
streaming/ffmpeg-patches/README.md
```

Danach fährt `PULSE_INTRA_REFRESH=1` beide Vendor gleich (der Sidecar wählt
den richtigen Optionsnamen). Ohne den Patch **bricht der Start ab** statt
still Keyframes zu fahren — das ist Absicht: ein Keyframe-Lauf unter dem
Etikett „Intra-Refresh" wäre schlimmer als ein Fehler.
