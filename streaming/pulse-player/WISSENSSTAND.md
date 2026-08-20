# Wissensstand nativer HQ-Player — Stand 2026-07-29

Bestandsaufnahme nach drei Tagen Arbeit am Player und zwei Tagen Messreihen.
Zweck: **Grundlage für Schlussfolgerungen.** Jede Aussage unten ist einer von
vier Klassen zugeordnet, und diese Zuordnung ist der eigentliche Inhalt:

| Klasse | Bedeutung |
|---|---|
| **GEMESSEN** | mit Zahlen belegt, Kontrolle vorhanden, möglichst wiederholt |
| **GELESEN** | aus Quelltext oder Binärprogramm abgelesen — Tatsache, aber kein Verhalten unter Last |
| **VERMUTET** | plausibel, nicht geprüft. **Nicht als Grundlage für Entscheidungen benutzen.** |
| **WIDERLEGT** | war einmal behauptet, ist gemessen falsch |

Volle Protokolle in `../testbench/profiles/` (34 Akten). Diese Datei ersetzt
sie nicht, sie ordnet ein.

---

## 1. Was der Player ist — Zeitachse und Umfang

**GELESEN** (git):
- Erster Commit **2026-07-26** (`cc6f254d`), zuletzt 2026-07-29 (`a15bdf8b`).
  **Drei Tage, 35 Commits.** `jitter.rs` war vom ersten Commit an dabei.
- 20 Quelldateien, 9096 Zeilen. Größte: `depacket/av1.rs` (1140),
  `decode.rs` (903), `recorder.rs` (809), `app/mod.rs` (784), `audio.rs` (700).

Er ist der einzige Sidecar, der **empfängt** statt zu senden: WHEP →
Jitter-Puffer → Depacketisierung → FFmpeg-Decode → eigenes wgpu-Fenster.
Gleiches stdio-JSON-RPC wie die Capture-Sidecars.

---

## 2. Die Verarbeitungskette — wie sie tatsächlich arbeitet

**GELESEN** (`session.rs`, `jitter.rs`, `depacket/`, `decode.rs`):

```
WHEP (whep.rs)
  → Jitter-Puffer (jitter.rs)      sortiert nach Sequenznummer
  → Assembler (depacket/)          setzt Zugriffseinheiten zusammen
  → VideoDecoder (decode.rs)       FFmpeg, Hardware zuerst
  → Renderer (render/)             wgpu
```

### Der Jitter-Puffer hält Pakete NICHT generell zurück

**GELESEN**, `jitter.rs::poll` Zeile 232-241: Ist das nächste erwartete Paket
da (`first == next`), geht es **sofort** durch — ohne jede Wartezeit. Die
`jitter_ms` sind eine **Geduldsgrenze bei Lücken**, kein Vorhalt: Nur wenn
etwas fehlt, wartet der Puffer bis zu dieser Zeit, ob es noch eintrifft.

Das deckt sich mit der gemessenen Ende-zu-Ende-Zeit von 17,4 ms bei
20 ms `jitter_ms` — bei einem echten Vorhalt wäre das unmöglich.

**Konsequenz, die ich am 2026-07-29 zunächst übersehen hatte:** Der Puffer ist
bereits adaptiv. Ein höherer Wert kostet im störungsfreien Betrieb nichts.

**Inzwischen GEMESSEN, nicht mehr vermutet** (Hetzner, Zeitmuster, je zwei
Läufe, Messakte `profiles/nack-2026-07-29-was-die-geduld-kostet.json`): ohne
Störung sind 20 und 100 ms **identisch** (104,8 gegen 104,7 ms). Unter
Bündelverlust kostet die größere Geduld **+16 ms** (103,8 → 119,8) und bringt
dafür die volle Bildrate (56 → 60) sowie weniger endgültigen Verlust
(150 → 136). Ein Rückstand baut sich **nicht** auf (erste gegen letzte fünf
Sekunden −2,6 ms). Die Vorgabe steht seitdem auf 100
(`proto.rs::JITTER_MS_VORGABE`); die 17,4 ms oben stammen aus der Zeit mit 20.

### Verlust-Verhalten: zwei Wege, der ältere ist abgeschaltet

**GELESEN**, `decode.rs::on_gap`:

- **Standard (heute aktiv):** weiterdekodieren, aber die **Anzeige sperren**
  (`unsauber_bis`) für die Dauer eines Auffrisch-Durchlaufs
  (`PULSE_PLAYER_REFRESH_MS`, Vorgabe 2000 ms). Die Sperre endet vorzeitig,
  sobald ein echtes Vollbild eintrifft. Der Decoder wird **nicht** geleert.
- **Alt (`PULSE_PLAYER_GAP_WAIT_KEYFRAME=1`):** `flush()` + auf Einstiegspunkt
  warten, alles davor verwerfen.

Zusätzlich fordert `session.rs` bei einer Lücke ein Vollbild an (RTCP PLI),
gedrosselt auf 200 ms (`KEYFRAME_REQUEST_INTERVAL`).

**Wichtig und nicht offensichtlich:** Der `flush()`-Aufruf, der am 2026-07-28
gegen einen Segfault eingebaut wurde, liegt im **alten** Weg. Der Standardweg
flusht nach einer Lücke nicht. Die zweite `flush()`-Stelle (nach einem
abgelehnten Paket, `decode.rs:446`) ist unabhängig davon aktiv.

---

## 3. Stellschrauben

**GELESEN.** Optionen über `open`/`set_option` (`proto.rs::defaults`):

| Option | Vorgabe |
|---|---|
| `jitter_ms` | 20 |
| `deband` | 0.6 |
| `dither` | true |
| `zoom` / `pan_x` / `pan_y` | 1.0 / 0.5 / 0.5 |
| `volume` | 1.0 |
| `av_offset_ms` | 0 |
| `paused` | false |
| `hwdec` | None (= Hardware zuerst, Software als Rückfall) |

Env-Schalter (23 Stück). Die betriebsrelevanten:

| Schalter | Wirkung |
|---|---|
| `PULSE_PLAYER_NACK_INTERVAL_MS` | Nachforderungs-Takt, Vorgabe **10** (seit 2026-07-29; vorher Bibliotheks-Vorgabe 100) |
| `PULSE_PLAYER_REFRESH_MS` | Dauer der Anzeigesperre nach einer Lücke, Vorgabe 2000 |
| `PULSE_PLAYER_GAP_WAIT_KEYFRAME` | alter Verlust-Weg (flush + warten) |
| `PULSE_PLAYER_DECODE_THROUGH` | nach Lücke weiterdekodieren ohne zu warten |
| `PULSE_PLAYER_NO_KEYFRAME_REQUEST` | keine Vollbild-Anforderung senden |
| `PULSE_PLAYER_LATENCY_PROBE` | Zeitmuster aus dem Bild zurücklesen |
| `PULSE_PLAYER_DUMP_RTP` | RTP-Nutzlasten mitschneiden |

Wichtige Konstanten: `ERROR_LIMIT=30` (Ablehnungen bis Neuaufbau),
`MAX_REBUILDS=2`, `MAX_WARTEZEIT_OHNE_KEYFRAME=20 s`, `MAX_BUFFERED=2048`.
Die Wartezeit war bis zum 2026-08-18 eine Bildzahl (`1200`) und schrumpfte
dadurch mit steigender Bildrate — bei 144 fps auf 8,3 s.

---

## 4. Wissensstand zur Verlust-Robustheit

### GEMESSEN

**Intra-Refresh heilt sich nach Verlust NICHT** (`decoder-2026-07-29-intra-refresh.json`).
Ein einziges verworfenes Bild genügt: `av1_cuvid` liefert weiter Bilder ohne
Fehlermeldung, aber alle 148 danach sind byte-identisch mit dem Vorgänger
(PSNR 24 dB, nie wieder sauber). `libdav1d` gibt gar nichts mehr aus.
Gegenprobe: derselbe Verlust mit Keyframes heilt byte-perfekt (100 dB) beim
nächsten Vollbild. `-flags +output_corrupt` und `-err_detect ignore_err`
ändern nichts.

**MediaMTX liefert verlorene Pakete nach** (`nack-2026-07-29-stufe3.json`).
Nullkontrolle ohne Störung: 56651 Pakete, 0 Wiederholungen. Mit 5 % Verlust:
505. Läuft trotz `rtx NEIN` — als Wiederholung des Originalpakets, nicht als
RFC-4588-RTX.

**Der Nachforderungs-Takt war der Engpass** (dieselbe Akte). A/B, je zwei Läufe,
1 % Verlust, live-kodierte Vorlage:

| | 100 ms | 10 ms |
|---|---|---|
| Paketverlust (Player-Sicht) | 304,8 / 321,2 | 25,2 / 22,6 |
| Bildrate (Soll 144) | 99,6 / 112,3 | 140,6 / 140,7 |
| Verspätung, Untergrenze | ~100 ms | 18,0 ms |
| rechtzeitig bei 20-ms-Puffer | 0 von 557 | 22 von 22 |

Gegengeprüft über die NACK-Abstände im Mitschnitt selbst: 100,0 ms alt,
10,0 ms neu.

**Umlaufzeit zum Testserver: 59,4 / 61,0 / 65,8 ms** (30 Pings).
Daraus folgt zwingend: Eine Nachlieferung braucht mindestens eine volle
Umlaufzeit. Mit 20 ms Geduld kann sie dort nie ankommen.

**Die Teststrecke verliert bei passender Bitrate nichts**
(`nack-2026-07-29-echte-leitung.json`). Zwei Läufe, 11591 und 15641 Pakete:
null Verlust, `fps` 58,8 und 59,1 bei Soll 60. **Grenze der Aussage:** gilt für
diese Strecke, an diesem Abend, über WLAN. Keine Aussage über Nutzerleitungen.

### GELESEN

**Niemand in unserer Kette kann FEC** (`fec-2026-07-29-machbarkeit.json`).
Sidecar und Player nutzen webrtc-rs 0.17 — kein FEC-Modul; `video/ulpfec` wird
deklariert (Payload-Typ 116), nirgends verarbeitet. MediaMTX setzt auf pion
auf, **pion hat FlexFEC vollständig**, MediaMTX kompiliert es nicht ein (im
Binärprogramm nur `nack`, `report`, `stats`, `twcc`).

**NVENC kennt `error_resilient_mode` nicht** — der Begriff kommt in
`nvEncodeAPI.h` kein einziges Mal vor. Anders als bei LTR ist hier nicht
FFmpeg die Sperre.

**NVENC kann mehr, als FFmpeg durchreicht**: `NV_ENC_CONFIG_AV1` hat
`enableLTR`, `enableTemporalSVC`, `numTemporalLayers`. `av1_nvenc` bietet in
FFmpeg genau einen einschlägigen Schalter: `intra-refresh`.

### VERMUTET — nicht als Grundlage benutzen

- Ein höherer `jitter_ms` kostet im störungsfreien Betrieb nichts. Aus dem
  Code abgeleitet (Abschnitt 2), **nicht gemessen**.
- Zeitstufen (Temporal Layers) würden die Verlust-Anfälligkeit senken, weil
  Verluste in oberen Stufen folgenlos blieben. Plausibel, nirgends geprüft.
- Bei 10 ms Nachforderungs-Takt werden nur 22 statt 557 Verspätungen
  zugeordnet, weil die Nachlieferung eintrifft, bevor die Lücke sichtbar wird.
  Wäre der günstigste Fall, ist unbelegt.

### WIDERLEGT — stand einmal so da, ist falsch

- **„Ohne RTX liefert der Server nichts nach"** (Kommentar in `whep.rs`, bis
  2026-07-29). Gemessen widerlegt; pion sendet das Originalpaket erneut.
- **„Der Player stürzt bei Paketverlust reproduzierbar ab"** (meine Aussage,
  2026-07-29 vormittags). Artefakt der Prüfvorlage: mit `synth10.mkv` 5
  Abstürze in 5 Läufen, mit live-kodierter Vorlage 0 in 3.
- **„87 Parse-Fehler = Defekt unserer Zusammensetzung"**. Ebenfalls
  Vorlagen-Artefakt; der Assembler baut nachweislich heile Einheiten (0 von
  1141 kaputt), und dieselben Einheiten als Datei ergeben null Fehler.
- **„Die NACK-Frage ist im heutigen Betrieb akademisch"** (meine Formulierung).
  Falsche Rahmung: Die Teststrecke verliert nichts, das sagt nichts über
  Nutzerleitungen.
- **„Ein adaptiver Puffer müsste gebaut werden"**. Er existiert bereits
  (Abschnitt 2).

---

## 5. Der Prüfstand — was er kann und wo er trügt

**Die Prüfvorlage bestimmt das Ergebnis.** `synth10.mkv` ist mit
av1_nvenc-**Datei-Defaults** kodiert und trägt Alt-Ref-Struktur: rund die
Hälfte aller Zugriffseinheiten sind reine „zeige ein vorhandenes Bild"-Header.
Der Live-Sidecar erzeugt das nie (`zerolatency=1`, `delay=0`, `b_ref_mode=0`).
Zwei Befunde eines Tages gingen allein daraus hervor. Werkzeug dagegen:
`live-vorlage.py` (Werte aus `encode/opts.rs::vendor_opts`), Quelle über
`PULSE_HARNESS_SOURCE`.

**Leitungsbudget zum Testserver: 10 Mbit Downstream.** Messungen müssen
deutlich darunter bleiben; 3000 kbps bei 60 fps laufen sauber. Wer höher geht,
misst den Engpass — und Überlastung sieht in den Zählern wie Verlust aus. Die
billigste Unterscheidung ist die Bildrate gegen das Soll.

**`netz-harness.py` braucht `--nur-empfang`**, sonst liegt die Störung an der
Wurzel von `lo` und trifft den Sendeweg mit. Kein Default.

**Werkzeuge** (`../testbench/`): `harness.py` (Referenzsender),
`real-harness.py` (echter Sidecar), `fern-harness.py` / `fern-nack.py` (echte
Leitung), `netz-harness.py` (Störprofile), `nack-wirkung.py`,
`obu-schnitt.py` + `heilung.py` (Decoder-Verhalten offline),
`live-vorlage.py`. Zwei Diagnosetests im Player (beide `#[ignore]`, beide
schlagen ohne ihre Env-Variable **fehl** statt still grün zu melden).

---

## 6. Wiederkehrende Fehlerarten dieser Messreihe

Fünfmal am 2026-07-29 dieselbe Sorte Fehler. Als Prüfliste:

1. **Ergebnis richtig, Begründung falsch.** Die 505 Nachlieferungen stimmten,
   während die Auswertung STUN-Pakete als RTP las. Eine Zahl, die stimmt,
   beweist ihre Erklärung nicht mit.
2. **Nicht passende Zahl wegerklärt.** Median 171 ms bei einem 100-ms-Takt ist
   ein Widerspruch — ich habe „offenbar ein zweiter Zyklus" daraus gemacht,
   statt ihn ernst zu nehmen.
3. **Kontext angenommen statt gemessen.** „2,3 von 20 Sekunden" — der
   Mitschnitt war 3,5 s lang. Ebenso: 25-Mbit-Vorlage auf 10-Mbit-Leitung.
4. **Lebendkontrolle mit Lücke.** Sie prüfte, ob zu WENIG nachgefordert wurde,
   aber nicht den Fall NULL — ausgerechnet der Totalausfall fiel durch.
5. **Vorschlag ohne Kenntnis des Bestands.** Der adaptive Puffer existierte
   bereits.

Daraus die Regeln, die in diesem Projekt tragen: erst das Werkzeug an
bekannten Daten prüfen, dann messen. Jede Messschleife braucht eine
Lebendkontrolle aus **unabhängiger** Quelle. Wiederholen, bevor ein
Unterschied behauptet wird. Und vor jedem Vorschlag nachsehen, was schon da
ist.

---

## 7. Offene Fragen, nach Tragweite

1. **Es fehlt eine Teststrecke, die tatsächlich verliert.** Lokal gibt es
   Verlust ohne Umlaufzeit, fern Umlaufzeit ohne Verlust. Gebraucht wird
   beides zugleich — Verlust nur auf dem Eingangsweg (per `ifb`), damit der
   Sendeweg sauber bleibt. **Ohne das ist weder ein tieferer Puffer noch FEC
   zu bewerten.** Das ist der Engpass, nicht die Frage nach dem Bedarf.
2. **Reicht ein höherer `jitter_ms`?** Ein Zahlenwert, kein Umbau — aber die
   Annahme dahinter (kostet nichts ohne Störung) ist ungemessen.
3. **Recorder verträgt kein Intra-Refresh** (wartet auf IDR). Blockiert auch
   die Qualitätsmessung über den echten Stream.
4. **Produktisierung Intra-Refresh**: heute nur über `PULSE_ENCODER_OPTS`;
   MediaMTX-Fork-Patch für die PLI-Weiterleitung ist gebaut, nicht committet.
5. **Entscheidung RTMPS → WHIP** steht beim Nutzer aus (RTMPS ist strukturell
   ruckelig, im TCP nicht behebbar).
6. **H.264 ist live ~15 ms langsamer als AV1** (41,0 gegen 25,8 ms bei
   1440p60) — unerklärt.
7. **Echte A/V-Synchronisierung** fehlt (heute Puffer-Näherung).
8. **Ab ~280 fps bündelt die Aufnahme** — eigener Faden, Compositor-Grenze.

---

## 8. macOS-Portierung — Stand 2026-08-20

### GEMESSEN

**Der Player baut und läuft auf macOS arm64** (macOS 15.7.3, rustc 1.96).

**Das gebündelte Verzeichnis ist portabel und nutzt nachweislich die
mitgelieferten Bibliotheken, nicht die der Baumaschine.** An einen fremden
Ort kopiert startet er unverändert; nimmt man ihm die gebündelte
`libavcodec.62.dylib` weg, bricht dyld beim Start mit `Library not loaded:
@loader_path/libavcodec.62.dylib` ab — der Loader-Pfad zeigt also wirklich
ins eigene Bundle-Verzeichnis, nicht auf eine System- oder Homebrew-Kopie.

**`health` antwortet aus dem App-Bundle heraus** mit
`{"ok":true,"codecs":["h264","av1"]}`.

### GELESEN

**Die gebündelte FFmpeg hat kein `libdav1d`**, nur den in FFmpeg selbst
eingebauten AV1-Decoder. Der Player probiert `libdav1d` zuerst und fällt
zurück (Abschnitt 2/3). Folge: der Software-Rückfall für AV1 ist auf macOS
langsamer als unter Windows, dessen BtbN-FFmpeg `libdav1d` mitbringt.

### VERMUTET — nicht als Grundlage benutzen

- **Dass VideoToolbox am echten Stream wirklich greift.** Gemessen ist nur
  der Bau und der isolierte Start (`health`); ein Lauf gegen die echte Kette
  mit zwei Clients steht noch aus.
