# HDR unter Linux sieht falsch aus — wo es wirklich herkommt (2026-08-10)

Maschine: RTX 5080, NVIDIA 610.57.04, KWin 6.7.3, Wayland, DP-2 in HDR
(PQ, `max 530`, `reference 295`, MaxCLL 295). Branch `feat/hdr-kms-helfer`.

## Der Anlass

Der über die Pulse-Kette gezeigte Bildschirminhalt stimmte nicht mit dem
Original auf demselben Schirm überein: **zu hell, Zeichnungsverlust in den
hellen Flächen, deutlich zu viel Kontrast.** Der Vergleich war direkt möglich,
weil der Player den Schirm zeigt, auf dem er selbst liegt.

## Was gemessen wurde, und was dabei herauskam

**Die ganze Kette ist bis einschließlich Player nachweislich richtig.**

| Glied | Befund | Beleg |
|---|---|---|
| Teststrom (8 PQ-Stufen) | **bitgenau** | alle 8 Stufen, Abweichung 0 |
| Player-Shader | **exakt** | `pulse-player --farbwerte`: PQ-Identität, <1 LSB |
| Anmeldung an KWin | **wirkt** | Parameteränderung verändert das Bild massiv |
| KWin-Ausgabe | **verbogen** | s. Tabelle unten |

Testbild: acht waagerechte Balken mit bekannter Leuchtdichte, als 10-bit-AV1
mit BT.2020/PQ gestreamt, im Player angezeigt, am **Scanout** (DRM/KMS,
`kms_hdr_nachweis`) gemessen — also das, was wirklich zum Schirm geht.

### Die Kennlinie der Kette (Pulse, beste Einstellung: Bezugsweiss 203, ohne Meister-Angaben)

| Soll cd/m² | Ist cd/m² | Faktor |
|---:|---:|---:|
| 1 | 0,1 | **0,13x** |
| 5 | 0,8 | 0,17x |
| 20 | 5,7 | 0,28x |
| 50 | 22,9 | 0,46x |
| 100 | 65,2 | 0,65x |
| 203 | 172,8 | 0,85x |
| 400 | 368,7 | 0,93x |
| 800 | 688,3 | 0,85x |

Also: Helles kommt fast richtig an, **Dunkles wird auf ein Achtel
heruntergedrückt** — überzeichneter Kontrast mit absaufenden Mitten. Genau der
Eindruck, der den Anlass gab.

### Der entscheidende Gegenversuch: derselbe Test in Brave

Brave meldet seine Fläche mit denselben Mitteln an (BT.2020 + PQ) und wird von
KWin **stärker** verbogen als Pulse:

| Soll cd/m² | Pulse | Brave |
|---:|---:|---:|
| 1 | 0,13x | 0,09x |
| 20 | 0,28x | 0,21x |
| 100 | 0,64x | 0,82x |
| 203 | **0,85x** | **2,55x** |
| 400 | **0,93x** | **5,17x** |
| 800 | **0,85x** | **8,93x** |

**Daraus folgt: Pulse ist nicht die Ursache.** Und der Grund, warum es bei
YouTube „richtig" aussieht und bei uns nicht, ist kein Qualitätsunterschied,
sondern die **Vergleichsmöglichkeit**: unser Bild ist ein Abbild desselben
Schirms, das Original liegt daneben. Beim Video fehlt die Referenz.

### Wie Brave anmeldet (`WAYLAND_DEBUG=1` mitgeschnitten)

```text
set_primaries_named(6)          # bt2020
set_tf_named(11)                # st2084_pq
set_luminances(0, 1000, 295)    # Bezugsweiss 295 (= das des SCHIRMS)
set_max_cll(295)
set_max_fall(295)
# KEIN set_mastering_luminance
```

Nicht offensichtlich: Brave nennt **295**, also den Schirmwert, obwohl der
Inhalt bis 800 cd/m² geht — es meldet nicht die Wahrheit über den Inhalt.
`set_mastering_luminance` benutzt es gar nicht; genau dieser Aufruf hat in
unseren Versuchen die Werte explodieren lassen (800 → 9891 cd/m²).

### Was am Protokoll wie wirkt (gemessen)

* **Ohne Leuchtdichte-Angaben** = wie `set_luminances(…, 203)`. 203 ist also
  die Vorgabe.
* **Bezugsweiss steuert nur den hellen Bereich.** 295 statt 203 macht alles
  dunkler (bei 203 cd/m²: 0,53x statt 0,85x).
* **Der dunkle Bereich bleibt bei 0,09–0,13x — in JEDER Einstellung.** Über das
  Protokoll ist er nicht erreichbar. Das ist das „crushed shadows"-Verhalten
  aus den KDE-Fehlerberichten.
* **`set_mastering_luminance` verschlimmert stark** (bis 12x zu hell oben).
* Kleinere gemeldete Spitze macht es oben **schlimmer**, nicht besser — KWin
  streckt dann, statt zu stauchen.

### Verdacht (inzwischen belegt — s. „Der Gegenversuch ist gelaufen")

KWins Tonemapper (offene KDE-Fehler [509114](http://www.mail-archive.com/kde-bugs-dist@kde.org/msg1108842.html)
„HDR Peak Brightness Clipping" und [506645](https://www.mail-archive.com/kde-bugs-dist@kde.org/msg1086939.html)
„HDR contrast/peak brightness broken"; seit KWin 6.4 bekannt).

## HIER GEHT ES WEITER

**Der Gegenversuch ist gelaufen (2026-08-10, nach Neuanmeldung) — der Verdacht
ist bestätigt.** Der Schalter war im laufenden KWin nachweislich gesetzt
(`sudo cat /proc/$(pgrep -x kwin_wayland)/environ` → `KWIN_DISABLE_TONEMAPPING=1`),
der Schirm stand unverändert auf denselben Werten wie oben (DP-2, SDR-Bezug 295,
Spitze 530, Max-Mittel 295).

### Dieselbe Messung, Tonemapper aus

| Soll cd/m² | mit Tonemapper | **ohne Tonemapper** |
|---:|---:|---:|
| 1 | 0,13x | **0,46x** |
| 5 | 0,17x | 0,42x |
| 20 | 0,28x | 0,35x |
| 50 | 0,46x | 0,32x |
| 100 | 0,65x | 0,29x |
| 203 | 0,85x | 0,26x |
| 400 | 0,93x | 0,23x |
| 800 | 0,85x | **0,20x** |

**Die Kennlinie kippt vollständig.** Das Kennzeichen des Fehlers — unten
zusammengedrückt, oben fast richtig — ist weg. Übrig bleibt ein Bild, das
gleichmäßig zu dunkel ist.

**Und zwar exakt gleichmäßig.** Rechnet man die Werte nicht in Leuchtdichte,
sondern in das PQ-Signal selbst zurück (`E' = (Code-64)/876`), ist das
Verhältnis Ist/Soll über alle acht Stufen **konstant 0,765** (0,763 · 0,769 ·
0,763 · 0,764 · 0,766 · 0,766 · 0,767 · 0,766). Das ist kein Kurvenfehler mehr,
sondern ein einziger Faktor.

### Zweiter Befund: das Bezugsweiss wirkt dann gar nicht mehr

Derselbe Lauf mit `PULSE_PLAYER_HDR_BEZUGSWEISS=295` statt 203 liefert
**dieselben Codes** (164/230/303/359/405/453/502/551 gegen
164/231/303/359/405/454/503/552 — Rundung). Mit Tonemapper machte derselbe
Wechsel bei 203 cd/m² noch 0,53x statt 0,85x. **Das Bezugsweiss war also die
ganze Zeit eine Eingabe an den Tonemapper**, nicht an die Ausgabe.

### Die entscheidende Gegenprobe: Brave landet auf derselben Kurve

Damit war die Frage: Ist der Restfaktor 0,765 KWins — oder unserer? Also
dasselbe Testbild als PQ-getaggtes AVIF in Brave, gleicher Schirm, gleicher
Moment:

| Soll cd/m² | Pulse (ohne TM) | Brave (ohne TM) |
|---:|---:|---:|
| 1 | 0,46x | 0,65x |
| 5 | 0,42x | 0,43x |
| 20 | 0,35x | 0,36x |
| 50 | 0,32x | 0,30x |
| 100 | 0,29x | 0,28x |
| 203 | 0,26x | 0,24x |
| 400 | 0,23x | 0,23x |
| 800 | 0,20x | 0,20x |

Brave im PQ-Signal: ebenfalls konstant ~0,76. (Die unterste Stufe streut, sie
ist die unempfindlichste — 1 cd/m² liegt bei Code 195 gegen 177/164, und Braves
Bild wird von 1920 auf 2560 hochgerechnet.)

Mit Tonemapper lagen die beiden **weit** auseinander (Brave 2,55x/5,17x/8,93x
oben gegen Pulses 0,85x/0,93x/0,85x). Ohne ihn liegen sie **aufeinander**.

## Was daraus feststeht

1. **KWins Tonemapper ist die Ursache** des verbogenen Bildes — der zerdrückte
   Schattenbereich und die Spreizung zwischen zwei Anwendungen verschwinden
   beide mit ihm. Deckt sich mit KDE 509114 / 506645.
2. **Pulse ist sauber.** Zwei unabhängige Anwendungen durch denselben
   Compositor kommen auf dieselbe Kurve; der Rest gehört nicht uns.
3. **Der Restfaktor ~0,765 im PQ-Signal ist eine zweite, davon getrennte
   Sache** und trifft Brave genauso. `KWIN_DISABLE_TONEMAPPING=1` ist damit
   **keine Empfehlung für Nutzer** — es tauscht „verbogen" gegen „durchgehend
   auf etwa ein Viertel gedimmt". Der Schalter ist ein Messwerkzeug, mehr nicht;
   die Datei `~/.config/environment.d/kwin-hdr-test.conf` ist nach dem Versuch
   wieder gelöscht (wirksam ab nächster Anmeldung).

## Wenn jemand hier weitermacht

Offen ist nur noch der Restfaktor 0,765 — und der ist ein KWin-/Treiber-Thema,
kein Pulse-Thema. Wer ihn verfolgen will, braucht die Trennung „KWin" gegen
„NVIDIA": zweiter Compositor (Mutter oder verschachteltes Sway) mit demselben
Testbild. Für Pulse selbst ist der Punkt erledigt; was bleibt, ist die
Dokumentation als bekannte Einschränkung unter KDE.

### Messung wiederholen (vollständig, Stand 2026-08-10)

Der Weg musste diesmal von Hand wieder aufgebaut werden — hier steht er ganz:

1. **auth-hook starten** (MediaMTX lehnt sonst jede Verbindung ab):
   `REDIS_URL=redis://localhost:6380/0 uv run --package dcc-mediamtx-auth-hook uvicorn dcc_mediamtx_auth_hook.app:app --host 127.0.0.1 --port 8005`
2. **Testbild**: `python3 testbild-erzeugen.py` → `/tmp/tb.yuv`
3. **Marken von Hand nach Redis** (media-svc wird nicht gebraucht) — je ein
   Satz mit `scope: publish` und `scope: read`, gleiche `channel_id`/`user_id`/
   `nonce`, Schlüssel `stream:token:<hex32>`, Aufbau siehe
   `services/media-svc/src/dcc_media_svc/streamkeys.py`.
4. **Schieben** (RTMPS, self-signed → `-tls_verify 0` **hinter** die
   Ausgabeoptionen, sonst „Option not found"):
   ```bash
   ffmpeg -re -stream_loop -1 -f rawvideo -pix_fmt yuv420p10le -s 1920x1080 -r 30 -i /tmp/tb.yuv \
     -c:v av1_nvenc -preset p1 -tune ull -b:v 20M -g 60 -pix_fmt p010le \
     -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc -color_range tv \
     -tls_verify 0 -f flv "rtmps://localhost:1936/channel-<cid>-<uid>-<nonce>?user=x&pass=<publish-token>"
   ```
5. **Player**: `player-treiber.py <pulse-player> "http://localhost:8889/<pfad>/whep?token=<read-token>" <log>`
6. **Scanout**: `sudo …/examples/kms_hdr_nachweis DP-2 out.ivf 8`
7. `ffmpeg -i out.ivf -frames:v 1 -pix_fmt yuv420p10le -f rawvideo out.yuv`
8. `python3 balken-messen.py out.yuv` — findet das Testbild selbst

**Brave-Gegenprobe**: `tb.yuv` als PQ-AVIF backen und in einem App-Fenster auf
DP-2 zeigen (`brave-gegenprobe/` in diesem Verzeichnis). Ein Canvas mit
`colorSpace: 'rec2100-pq'` **funktioniert nicht** — `fillStyle` mit
`color(rec2100-pq …)` malt nichts, das Bild bleibt schwarz.

**Zwei Fallen, die je einen Anlauf gekostet haben.** `balken-messen.py` sucht
sich das Testbild selbst; liegt das Player-Fenster so, dass oben etwas abgeht,
findet es acht *falsche* Plateaus (schwarzer Rand als erstes, unterster Balken
fällt raus) und die Tabelle ist um eine Zeile verschoben — steht in der Ausgabe
`Balken y=0..`, ist der Lauf ungültig. Und `pgrep -f '<muster>'` trifft in
dieser Shell **die eigene Kommandozeile**: `pgrep -f pulse-player | xargs kill`
bringt sich selbst um (Exit 144, nichts passiert). `pulse-play[e]r` schreiben.

## Stand des Codes (uncommitted, Worktree `agent-a0d2b1605c374ea00`)

* `render/hdr_tag.rs` **neu** — meldet die Fläche über `wp_color_management_v1`
  als BT.2020/PQ an. Herstellerneutral (KWin, Mutter, wlroots, Hyprland).
* `render/hdr_fenster.rs` — `HDR_OBERFLAECHE` ist auf Linux jetzt
  `Rgb10a2Unorm` (PQ) statt `Rgba16Float` (scRGB); Windows unverändert.
  **Grund:** bei `Rgba16Float` meldet der NVIDIA-Treiber die Fläche SELBST an
  (als scRGB mit Bezugsweiss 203), und ein zweites `get_surface` ist ein
  Protokollfehler, der die ganze Wayland-Verbindung beendet.
* `render/farbe.rs` — `ist_pq_fenster()`, setzt `hdr.w` im Uniform-Block.
* `render/shader.wgsl` — PQ-Fenster: Werte unverändert durchreichen.
* `Cargo.toml` (Player **und** Sidecar): `ffmpeg-next` 8.1 → **9.0**, weil das
  System-FFmpeg auf 9.0 steht. Ohne den Bump baut nichts mehr.

**Noch offen am Code (unabhängig vom KWin-Befund):**
* Die Spitze steht als `PULSE_PLAYER_HDR_SPITZE`/`…_BEZUGSWEISS` in
  Umgebungsvariablen — sie muss aus dem Strom kommen
  (`decode::Farbangaben::spitze_nits`). Dafür muss die Anmeldung vom
  Fensteraufbau in den Moment wandern, in dem der Strom bekannt ist.
* `pulse-player --farbwerte` prüft noch gegen die **scRGB**-Sollwerte und meldet
  deshalb „ABWEICHUNG", obwohl der PQ-Weg exakt ist. Sollwerte für den PQ-Weg
  nachziehen (`messen/sollwerte.rs`, `messen/farbwerte.rs`).
* `PULSE_PLAYER_KEIN_FARBTAG=1` ist der Gegenversuch-Schalter (Fläche bleibt
  ungetaggt → Player rechnet selbst auf SDR herunter).
* Doku nachziehen: `linux-hq-sidecar/CLAUDE.md` und `pulse-player/README.md`
  wissen noch nichts vom PQ-Weg.
