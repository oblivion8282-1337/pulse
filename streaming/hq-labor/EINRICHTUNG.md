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
cargo test --release                # muss grün sein (122 Tests)
```

Das Skript wendet **alle** Patches aus `patches/` an. Zwei sind es derzeit:

* `0001-…-expose-undeclared-ssrc-streams` — nötig, damit der Paritätsstrom
  überhaupt sichtbar wird (er trägt eine eigene, im SDP nicht angekündigte
  Quellkennung).
* `0002-nack-generator-resend-delay` — die NACK-Sperrfrist, ohne die dieselbe
  Lücke sechs- bis achtmal angefordert wird.

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

Die Umstellung auf Intra-Refresh ist auf Linux+NVIDIA vermessen und gewinnt
dort in jeder Kennzahl. **Für AMD ist ungeklärt, ob sie überhaupt geht** —
`av1_vaapi` bietet keine `intra-refresh`-Option an, und ob die Hardware es
könnte, sagt nur der Treiber selbst:

```bash
cd streaming/testbench
cc -o /tmp/vaapi-ir vaapi-intra-refresh-pruefen.c -lva -lva-drm
/tmp/vaapi-ir
```

Steht bei AV1 oder H.264 ein JA, kann die Hardware es und nur FFmpeg ist im
Weg. Steht überall NEIN, bleibt für AMD nur `h264_amf` (AMDs eigene
Schnittstelle, kann Intra-Refresh, aber nicht für AV1) — und die nutzt unser
Sidecar bisher gar nicht.
