# pulse-player — nativer HQ-Stream-Player

Zeigt einen HQ-Stream (WHEP von MediaMTX) in einem **eigenen Fenster** an, statt
ihn durch Chromiums Compositor zu schicken. Das Fenster oeffnet **ohne
Aktivierung** (`with_active(false)`): Pulses Tastenkuerzel hoeren am Fenster der
Web-App zu und wirken nicht mehr, sobald ein anderes Fenster den Tastatur-Fokus
hat — beim Zuschauen soll man weiter in Pulse tippen koennen. Wer die Bedienung
im Fenster benutzt, nimmt ihm den Fokus zwangslaeufig; ein Klick zurueck in
Pulse stellt ihn wieder her. Gesteuert wird er von Electron ueber
dasselbe stdio-JSON-RPC wie die HQ-Capture-Sidecars.

**Er ist additiv.** Browser-Nutzer und jede Installation ohne dieses Binary
bekommen den Stream unveraendert ueber `web/src/lib/stream/components/WhepPlayer.svelte`
im `<video>`-Element. Der Player ist ein Opt-in fuer die Electron-App.

## Warum es ihn gibt

Gemessen am 2026-07-26 auf der Dev-Maschine (RTX 5080, CachyOS, KWin 6.7.3):

| Befund | Messung |
|---|---|
| Chromium legt seinen Wayland-Puffer immer als `ABGR8888` an | 8 bit pro Kanal — in SDR, mit `--force-color-profile=scrgb-linear`, **und** mit aktivem HDR |
| Im HDR-Fall signalisiert Chromium PQ, liefert aber weiter 8 bit | `set_tf_named(11)` bei `AB24`-Puffer |
| KWin bietet daneben hoehere Formate an | Scanout-Ebene lief auf `AB30` (10 bit) bzw. `AB4H` (fp16) |
| Chromium nutzt auf Linux/NVIDIA kein NVDEC | `nvidia-smi dmon` zeigte `dec` durchgehend 0 %, auch mit VA-API-Flags; ~4,6 s CPU-Zeit in 10 s |

Die 8 bit sind also Chromiums Wahl, nicht die Grenze des Systems. Dieser Player
trifft beide Entscheidungen — Pufferformat und Decoder — selbst.

Verwandter Bug im Chromium-Tracker: *Severe banding on Wayland with HDR enabled*
(Issue 503402063). Titel passt zum Befund; Inhalt und Status waren ohne Login
nicht einsehbar.

## Was er kann

- **WHEP** wie der Browser-Client: nicht-Trickle, `POST` mit `application/sdp`,
  Resource-URL aus `Location`, `DELETE` beim Abbau. Die URL traegt bereits
  `?token=` und wird unveraendert durchgereicht.
- **AV1 und H.264**, Hardware-Decoder zuerst (`av1_cuvid`, `h264_cuvid`, `*_qsv`,
  `*_vaapi`), Software als Rueckfall.
- **Ausgabe mit mehr als 8 bit**, wenn der Compositor es anbietet: bevorzugt
  `Rgb10a2Unorm`, dann `Rgba16Float`, sonst 8 bit. Das tatsaechlich verhandelte
  Format steht in `stats.surface_format` — damit ist von aussen belegbar, was
  anliegt. Warum 10-bit-Unorm VOR fp16 steht, obwohl fp16 mehr Bits haette,
  steht in `render/setup.rs` (fp16 wird als lineares Licht gedeutet).
  **Was die zehn Bit wirklich bringen, ist gemessen** und kleiner als lange
  angenommen: `docs/2026-08-04-player-farbwerte-messung.md`, nachzustellen mit
  `pulse-player --stufen`.
- **HDR (PQ/BT.2020)**, seit 2026-08-06. Der Strom sagt, was er ist
  (`decode.rs::farbangaben_von` liest Kurve, Primaervalenzen und
  Spitzenhelligkeit — MaxCLL zuerst, Mastering-Display als Ersatz), und der
  Shader zieht daraus die Folgen: BT.2020-Matrix, PQ-Kurve rueckwaerts,
  Farbraumwandlung. **Zwei Ausgaenge, je nach Schirm:**
  - **HDR-Schirm** — das Fenster stellt auf `Rgba16Float` und meldet scRGB an
    (lineares Licht, 1,0 = 80 cd/m²). Spitzlichter bleiben Spitzlichter.
  - **SDR-Schirm** — Tone-Mapping (erweitertes Reinhard, Bezug Diffusweiss
    203 cd/m² nach ITU-R BT.2408). Ohne das saehe ein HDR-Strom flau und
    falsch aus; mit dem Abschneiden statt Herunterrechnen waeren die
    Spitzlichter weisse Flecken.

  **Unter Windows laeuft der Player dafuer ueber D3D12 statt Vulkan**
  (`render/setup.rs::backends`). Das ist Voraussetzung, keine Vorliebe: nur
  dort laesst sich der Farbraum des Fensters ueberhaupt anmelden
  (`IDXGISwapChain3::SetColorSpace1`); unter Vulkan ist er eine Eigenschaft der
  Swapchain, wird beim Anlegen gesetzt und ist von aussen weder zu setzen noch
  zu pruefen — und was wir nicht pruefen koennen, behaupten wir nicht. Dort
  wird deshalb heruntergerechnet. `PULSE_PLAYER_BACKEND=vulkan|dx12|gl` nagelt
  die Wahl fest.

  **Die Farbrechnung selbst ist gemessen, nicht angesehen** (2026-08-06,
  `pulse-player --farbwerte`, Akte
  `streaming/testbench/profiles/player-2026-08-06-hdr-farbweg.json`): fuenfzehn
  bekannte PQ-Codewerte durch den echten Shader, gegen Sollwerte aus SMPTE
  ST 2084 / BT.2020 / BT.709 / BT.2408, **beide Ausgaenge**. Jede Abweichung
  bleibt unter einer Stufe des Ausgabeformats, und bei neutralem Chroma sind
  R, G und B exakt gleich — es gibt keinen Farbstich.
  **Hier stand bis dahin „ob das Bild stimmt, muss jemand ansehen"; das war
  fuer die Rechnung falsch** und hat den Blick eines Menschen zum Messgeraet
  erklaert. Offen bleibt nur, was ein Blick wirklich allein entscheidet: wie
  der Compositor den scRGB-Puffer auf den konkreten Schirm bringt.
  Sendeseitig ist alles am Bitstrom belegt:
  `docs/2026-08-06-hdr-windows-amd.md`.
- **Bedienoberflaeche IM Fenster** (`src/overlay.rs`, egui): Lautstaerke samt
  Verstaerkung ueber 100 %, Stumm, Vollbild (Knopf, Doppelklick, Esc) und ein
  Statistik-Feld (Auflösung, Bilder/s, Bitrate, Decoder samt Hardware-Angabe,
  **Ausgabeformat**, verworfene und uebersprungene Bilder, Paketverlust,
  Pufferstand, Ton-Aussetzer). Blendet sich nach drei Sekunden ohne
  Mausbewegung aus. Ob ohne neues Bild ueberhaupt ein Durchgang noetig ist,
  entscheidet `Overlay::wants_redraw` VOR dem egui-Aufbau — an GRUENDEN
  (Eingabe liegt an, neue Zahlen, Ausblenden), NICHT am Zustand `visible`: mit
  „sichtbar" als Grund hielt sich die Schleife selbst am Leben, weil jede
  Ausgabe den naechsten Durchlauf ausloest (gemessen 2500-3400 Ausgaben je
  Sekunde bei 144 ankommenden Bildern). Ob das Overlay in einem Durchgang
  MITgezeichnet wird, haengt dagegen an `visible` — sonst verschwaende es,
  sobald wieder Bilder flossen. Eingaben fordern **keinen** eigenen Durchgang
  an, solange Bilder fliessen (`FRAME_FLOW_WINDOW` in `app`): das naechste Bild
  zeichnet das Overlay mit, bei 144 fps also spaetestens nach 7 ms. Sonst
  bekaeme jede Mausbewegung ihren eigenen Durchgang — gemessen bis zu 900 je
  Sekunde, die Abtastrate der Maus. Was hier bedient wird, geht durch dieselbe Stelle wie
  ein `set_option` per RPC; eine Aenderung der Lautstaerke meldet der Player
  zusaetzlich als `player:option`-Ereignis nach vorne, damit Pulse den Wert je
  Streamer behalten kann.
- **Debanding** im Shader. Wirkt auch bei 8-bit-Quellen und ist damit der
  staerkste Bildhebel, ohne die Encode-Kette anzufassen.
- **Einstellbarer Jitter-Puffer.** Die Fernsteuerungs-Messung ergab, dass 5-15 ms
  reichen; Chromiums WebRTC-Puffer laesst sich nicht dorthin zwingen.
- **Zoom und Pan** aus dem dekodierten Vollbild, nicht aus einem bereits
  herunterskalierten Fensterinhalt.
- **Standbild ohne Verbindungsabbruch** (`paused`): die Sitzung laeuft weiter.
- **Tonausgabe**: Opus wird dekodiert, auf die Rate des Ausgabegeraets gebracht
  und ueber cpal ausgegeben. `volume` wirkt inklusive Verstaerkung ueber 100 %,
  `av_offset_ms` als Ziel-Fuellstand des Ausgabepuffers. Laesst sich kein Geraet
  oeffnen, laeuft die Wiedergabe stumm weiter statt zu scheitern.
- **Mitschnitt ohne Neukodierung** (`record`/`stop_record`): der ankommende
  Bitstrom wird direkt gemuxt — Bild und Ton in einer Datei. Container je
  Codec, und das ist gemessen und nicht gewaehlt: **H.264 nach MPEG-TS**
  (nimmt Annex B nativ; Matroska verlangt dort `avcC` und Laengen-Praefixe und
  lehnt ab), **AV1 nach Matroska** (MPEG-TS traegt AV1 nicht, dort landet der
  Strom als `bin_data`; Matroska braucht den AV1CodecConfigurationRecord als
  `extradata`, der aus dem Sequence-Header des Stroms gebaut wird). Der
  benutzte Pfad kommt in der Antwort zurueck — die Endung kann von der
  angefragten abweichen.
- **Clip der letzten Sekunden** (`clip`): ein Ringpuffer haelt 60 s vor, auch
  wenn nicht aufgenommen wird. Der Schnitt beginnt am letzten Keyframe davor,
  sonst waere der Anfang unbrauchbar.
- **Eingabe-Erfassung fuer die Fernsteuerung** (`src/fernsteuerung/`), **Standard
  aus**. Der Op `input_capture` schaltet sie je Sitzung ein; danach kodiert der
  Player Maus und Tastatur in die Frames der Wire-Spec
  (`docs/plans/2026-08-12-input-wire-protokoll-v2.md`) und meldet sie als
  `player:input`-Ereignis nach vorne. Die absolute Zeigerposition ist ein Anteil
  am **Bild**, nicht am Fenster — Rand und Zoom werden herausgerechnet, der
  Nenner ist dabei `Breite − 1` (sonst waere die letzte Bildspalte unerreichbar,
  s. Wire-Spec), und ausserhalb des Bildes wird nichts gesendet. **Das gilt
  nicht nur fuer die Bewegung, sondern auch fuer Knopf und Rad**: ein Klick auf
  dem Briefkasten-Rand oder auf der Bedienleiste (die ueber dem Bild liegt, egui
  meldet ihn als „verbraucht") kaeme beim Host dort an, wo der Zeiger zuletzt IM
  Bild stand. Das **Loslassen** geht dagegen immer hinaus, sobald der Knopf beim
  Host wirklich unten ist — sonst klemmte er am fremden Rechner. Bruchteile
  (Praezisions-Touchpad, Wayland-`relative_pointer`) werden **aufgehoben statt
  gerundet**: einzeln gerundet ergaben sie dreifache Scrollgeschwindigkeit bzw.
  einen Zeiger, der sich bei langsamem Zielen gar nicht bewegte.
  Tastenzuordnung ist Scancode Satz 1 und damit layoutunabhaengig; was sich
  nicht abbilden laesst, wird nicht geraten, aber gezaehlt und einmal gemeldet.
  **Der Platz (`slot`) wird nur beim EINSCHALTEN gesetzt** — beim Ausschalten
  behaelt der Player ihn, denn die dann nachgereichten Hoch-Ereignisse gehoeren
  dem Stream, der gerade gesteuert wurde. **`remote_session`** benennt die
  Fernsteuerungs-Sitzung; der Player deutet sie nicht, sondern entscheidet
  daran, ob Liegengebliebenes des vorigen Stroms noch an dasselbe Ziel geht
  (anderes Ziel = verwerfen, der Host gibt beim Hello ohnehin alles frei).
  Verworfen werden sonst nur **ueberholte Bewegungen** — nie eine, an der ein
  Knopf oder das Rad haengt, sonst klickte der Host dort, wo sein Zeiger
  zufaellig steht. Steht die Abgabe so lange, dass selbst die unverwerfbaren
  Frames eine harte Grenze reissen, wird der Strom neu begonnen (Notbremse,
  in der Antwort als `emergency_resets`/`dropped_frames`). Was der Player NICHT
  tut: die Frames absetzen. Das macht die App (`desktop/electron/remoteInput.ts` buendelt,
  der Renderer sendet auf seiner Gateway-Verbindung).
- **Ehrliche Statistik**: empfangene, verlorene, umsortierte und doppelte Pakete,
  dekodierte und verworfene Frames, Pufferfuellstand, gewaehlter Decoder,
  Hardware ja/nein, Oberflaechenformat, dazu Ton-Unterlaeufe und Puffer-Stand
  sowie Aufnahmezustand und verfuegbare Clip-Sekunden.

## AV1-Rundlauf-Test gegen echte Daten: Depacketizer ist sauber

`depacket/av1.rs` hat einen Rundlauf-Test (echter AV1-Strom ueber den
`Av1Payloader` des `rtp`-Crates in RTP-Pakete zerlegt, durch unseren
`Av1Assembler` zurueck, gegen mehrere MTUs inkl. Fragmentierung und
Paketverlust). Ein frueherer Versuch hatte hier faelschlich einen
"OFFENER FEHLER: AV1-Wiedergabe funktioniert nicht" vermerkt und die Tests
`#[ignore]`d — das war eine **Fehldiagnose**.

Die tatsaechliche Ursache: `rtp` 0.17.2s
`codecs::av1::leb128::{encode_leb128,put_leb128}` (nur fuer den
`Av1Payloader` benutzt, NICHT fuer unseren Depacketizer) kodiert jedes
Laengenfeld >=128 fehlerhaft — die Funktion packt jede 7-Bit-LEB128-Gruppe in
ein volles 8-Bit-Byte-Slot (`<<= 8`), liest beim Serialisieren aber mit `>>= 7`
wieder aus; die Fehlausrichtung erzeugt ein zusaetzliches Muellbyte statt
gueltigem Standard-LEB128 (`put_leb128(474)` schreibt z. B. 3 Byte
`[0x83,0xb4,0x03]` statt der korrekten 2 Byte `[0xda,0x03]`). Der Rundlauf-Test
fuetterte unseren (korrekten, standardkonformen) Assembler also mit bereits
kaputten Testdaten und meldete den Fehler des Generators als Fehler des
Depacketizers.

`depacket/av1.rs::tests::roundtrip` baut das jetzt in
`fix_rtp_crate_leb128_bug()` per Nachschlagetabelle gegen eine 1:1-Kopie von
`encode_leb128`/`put_leb128` zurecht (nur die Laengenfeld-Bytes werden
korrigiert, die eigentliche Fragmentierungs-Entscheidung des Payloaders bleibt
unangetastet und damit weiter der Pruefgegenstand). Mit dem Fix laufen alle
Rundlauf-Tests gruen — inkl. Ende-zu-Ende-Dekodierung per `ffprobe` (gleiche
Bildanzahl wie das Original) und Paketverlust-Erholung. `Av1Payloader` wird in
Pulse aktuell nirgends produktiv zum Senden genutzt (nur als Dev-Dependency
hier), der Bug hat also keinen bekannten Praxis-Impact — ist aber ein fuer
sich stehender, reproduzierbarer Fehler in einer Abhaengigkeit.

Reproduktion:
```
ffmpeg -f lavfi -i "testsrc2=s=320x180:r=30:d=2" -c:v libsvtav1 -preset 12 \
  -f obu fixture.obu
PULSE_PLAYER_AV1_FIXTURE=fixture.obu cargo test depacket::av1
```

## Was er noch NICHT kann

Ehrlich benannt, damit niemand danach sucht:

- **Keine echte A/V-Synchronisierung.** Bild und Ton laufen getrennt: das Bild
  wird gezeigt, sobald es dekodiert ist, der Ton so schnell, wie das Geraet ihn
  abholt. `av_offset_ms` verschiebt nur den Fuellstand des Ausgabepuffers. Eine
  saubere Kopplung braeuchte eine gemeinsame Uhr aus den RTP-Zeitstempeln
  (`clock_rate` liegt dafuer schon bereit). Wie weit das in der Praxis
  auseinanderlaeuft, ist ungemessen.
- **Kein Standbild-Export.** Der Frame liegt vor, ein PNG-Encoder fehlt noch.
- **Zero-copy ist unter Windows die Vorgabe — aber auf NVIDIA wird er nie
  erreicht** (`PULSE_PLAYER_ZEROCOPY=0` schaltet ihn aus). Der Zusatz ist am
  2026-08-11 dazugekommen; bis dahin stand hier nur die erste Haelfte, und die
  liest sich wie eine Aussage ueber Windows, ist aber eine ueber AMD und Intel.
  Einzelheiten und Zahlen unter „Zero-Copy". **Hier stand bis zum 2026-08-06 abends „Kein zero-copy",
  danach „nur auf Anforderung (`PULSE_PLAYER_ZEROCOPY=1`)"; beides ist
  ueberholt** — die Einzelheiten stehen weiter unten unter „Zero-Copy". Mit
  `=0` gilt der ganze folgende Absatz unveraendert: jedes Bild nimmt den
  Weg GPU -> Hauptspeicher -> GPU zurueck (`decode.rs::in_den_hauptspeicher`,
  dann `render/mod.rs::upload`). Die reinen Kosten stehen in
  `streaming/testbench/profiles/player-2026-08-06-bildweg-kosten.json`: 1,5 ms
  je Bild bei 1080p in 8 bit, 5,3 ms bei 1440p in 10 bit.

  **Der teurere Teil ist aber nicht die Rechenzeit, sondern das Warten.** Am
  2026-08-06 auf einer Radeon 780M gemessen: unter Bewegung blockiert
  `av_hwframe_transfer_data` in Serien von 0,7 bis 2,4 Sekunden, waehrend
  Windows die Grafikeinheit zuruecksetzt (40 Video-TDR in 200 Sekunden). Der
  Player sieht davon keinen Fehler — der Aufruf kehrt erfolgreich zurueck, nur
  spaet. Bis dahin fiel die Sitzung danach auseinander und das Fenster ging zu,
  ohne dass irgendwo etwas stand; das sah wie ein Absturz aus und war keiner.
  Volle Herleitung:
  `streaming/testbench/profiles/player-2026-08-06-absturz-ist-eine-stockung.json`.

  Seither meldet `stockung.rs` jeden Durchgang ueber 300 ms mit seinen drei
  Abschnitten, und bei drei Stockungen in zehn Sekunden gibt der Player den
  Hardware-Decoder auf und stellt auf Software um. Das Bild wird teurer, aber
  es bleibt. `PULSE_PLAYER_STOCKUNGS_RUECKFALL=0` haelt den Hardware-Weg fest —
  fuer den Fall, dass man genau dieses Verhalten vermessen will.

  **Hier stand „Gebaut ist er nicht" — seit dem 2026-08-06 abends ist er
  gebaut** (s. „Zero-Copy" unten). Und er beseitigt diese Stockung **nicht**:
  mit Zero-Copy laeuft gar kein Ruecklesen mehr, die Stockungen bleiben in
  derselben Groesse, und die Zeit steht dann im eigenen Zaun. Es ist also die
  Grafikeinheit selbst, die haengt, und nicht der Weg des Bildes — was vorher
  nicht zu unterscheiden war.
- **Hier stand bis 2026-08-05 „Nur unter Linux getestet … Windows und macOS
  sind ungeprueft". Fuer Windows stimmt das nicht mehr.** Auf Windows + NVIDIA
  (RTX 5080) laeuft er mit Hardware-Dekodierung — `h264_cuvid` und `av1_cuvid`,
  8 wie 10 bit —, geprueft gegen die echte Kette (win-hq-sidecar -> eigener
  WHIP-Sendeweg -> gepatchtes MediaMTX -> Player) samt Ton und nachtraeglichem
  Einstieg in einen Intra-Refresh-Strom ohne periodische Vollbilder. Seither
  wird er auch im Windows-Installer mitgeliefert (`electron-builder.yml`,
  `win-build.yml`). **macOS bleibt ungeprueft** und wird nicht ausgeliefert.
- **AV1-Depacketisierung ist nur durch Unit-Tests abgesichert**, nicht gegen
  einen echten Stream. Siehe unten.

## Zero-Copy: das Bild bleibt im Grafikspeicher (Windows — AMD und Intel)

**Seit dem 2026-08-06 (nachts) die Vorgabe**; `PULSE_PLAYER_ZEROCOPY=0` schaltet
ihn aus. **Hier stand bis dahin „auf Anforderung, `PULSE_PLAYER_ZEROCOPY=1`" —
der Schalter zeigt jetzt in die andere Richtung**, und der Grund fuer die
Sonderstellung ist weggefallen (s. „Wer noch mitliest").

> **Auf NVIDIA laeuft dieser ganze Abschnitt nicht.** Die Ueberschrift hiess bis
> zum 2026-08-11 „(Windows, Vorgabe)", und das war zu breit: der Weg haengt am
> **D3D11VA**-Bild, und auf einer NVIDIA-Karte kommt der Player dort nie an.
> `av1_cuvid`/`h264_cuvid` stehen in der Kandidatenliste **vor** dem nativen
> Decoder, sie oeffnen anstandslos, und ohne CUDA-Geraet (die Vorgabe ausserhalb
> von Linux) legen sie ihr Bild schon im Hauptspeicher ab. `bruecke_moeglich`
> ist damit falsch, und die Bruecke wird nicht gefragt — kein Fehler, keine
> Meldung, nur der langsamere Weg.
>
> Nachgemessen am 2026-08-11 auf einer RTX 5080 (Treiber 610.47), je drei
> abwechselnde Laeufe zu 45 s, 1080p60 ueber die echte WHEP-Kette; Messakte
> `streaming/testbench/profiles/player-2026-08-11-zerocopy-nvidia.json`:
>
> | je Bild | heute (`av1_cuvid`) | mit Bruecke (`PULSE_PLAYER_DECODER=av1+hw`) |
> |---|---|---|
> | 8 bit — hochladen / dekodieren | 1,20 / 4,35 ms | **0,00 / 2,60 ms** |
> | 10 bit — hochladen / dekodieren | 2,20 / 5,90 ms | **0,00 / 2,95 ms** |
>
> Das Bild ist auf beiden Wegen dasselbe (mittlere Abweichung 0,03 bzw. 0,06 von
> 255 — Dither, kein Versatz und keine Farbverschiebung), HDR laeuft auf beiden.
> **Die Vorgabe ist trotzdem nicht umgestellt worden:** belegt ist die
> Kostenseite, nicht die Robustheitsseite (Verhalten nach Paketverlust,
> Wiederaufsetzen, Intra-Refresh-Einstieg), und `decode.rs` fuehrt fuer cuvid
> mehrere hart erarbeitete Sonderbehandlungen, die fuer D3D11VA niemand geprueft
> hat. Wer die Vorgabe drehen will, misst das zuerst.
>
> Sichtbar ist der Fall jetzt wenigstens: der Player schreibt beim ersten Bild
> `Bildweg ueber den Hauptspeicher — fuer NV12 gibt es auf dieser Plattform
> keine Zero-Copy-Bruecke`.

Gemessen an der laufenden Kette (Radeon 780M, 1080p60 in 10 bit, HDR, je zwei
Runden zu 75 s, Vorgabe gegen `=0` auf demselben Material):

| Posten je Bild | Ruecklesen (`=0`) | Zero-Copy (Vorgabe) |
|---|---|---|
| hochladen | 1,1-1,4 ms | **0,3-0,4 ms** |
| dekodieren (Mittel) | 4,2-6,0 ms | **2,6-2,8 ms** |
| dekodieren (Spitze) | 7,8-11,2 ms | 3,9-4,4 ms |

Messakten:
`streaming/testbench/profiles/player-2026-08-06-zerocopy-im-player.json` (der
Weg selbst) und `player-2026-08-06-einfrier-waechter-auf-der-gpu.json` (der
Fingerabdruck und die Umstellung der Vorgabe).

**Der Fingerabdruck kostet rund 0,3 ms davon.** Vor ihm stand hier 0,0-0,1 ms
Hochladen; der Rechendurchgang samt eigener Abgabe an die Warteschlange und dem
Nachfragen nach fertigen Ergebnissen laeuft in genau diesem Posten. Gegen 1,1-1,4
ms Ruecklesen bleibt der Gewinn.

### Wer auf diesem Weg noch mitliest — und wer nicht

| Wache | Ruecklesen | Zero-Copy | woran sie haengt |
|---|---|---|---|
| `stockung.rs` — haengende Grafikeinheit | ja | **ja** | reine ZEIT (300 ms je Durchgang), liest keine Bildpunkte |
| `einfrieren.rs` — Decoder liefert immer dasselbe Bild | ja | **ja, seit 2026-08-06 nachts** | Fingerabdruck: ueber alle Ebenen im Hauptspeicher bzw. ueber die Luma-Ebene auf der GPU |
| `probe.rs` — Latenz-Sonde | ja | **nein, sagt es aber** | gemaltes Muster in der Luma-Ebene im Hauptspeicher |
| `PULSE_PLAYER_DUMP_RTP` — RTP-Mitschnitt | ja | ja | sitzt VOR dem Decoder, war nie betroffen |

Die erste Zeile ist die wichtigere: **der Fall, der die Sitzung wirklich
zerreisst (die Grafikeinheit haengt), wird von `stockung.rs` erfasst, und der
arbeitet auf beiden Wegen unveraendert.** Der Einfrier-Waechter deckt den
selteneren Fall ab — der Decoder rechnet nicht mehr, liefert aber weiter Bilder.

**Wie der Abdruck auf die GPU kommt** (`render/abdruck.rs` + `abdruck.wgsl`,
Rechenvorschrift und CPU-Zwilling in `einfrieren/gpuabdruck.rs`): ein
Rechendurchgang ueber die Luma-Ebene der eingehaengten Textur summiert je
Bildpunkt einen gemischten Wert, in den die POSITION eingeht (`mische(mische(
index) ^ wert)`, Murmur3 `fmix32` — eine Bijektion). Damit aendert ein einzelner
veraenderter Bildpunkt den Abdruck garantiert; eine Summe der Helligkeiten waere
der Fehler vom 2026-08-05 in neuer Gestalt. Zwei solche Summen ergeben die 64
bit.

**Abgeholt wird asynchron**: je Bild wird das Ergebnis angefordert und in einen
von drei Puffern kopiert, eingesammelt wird, was aus frueheren Bildern fertig
dasteht. Ein blockierendes Ruecklesen je Bild waere genau die Rundreise, die
dieser Weg beseitigt. Der Waechter zaehlt ueber Sekunden — ein Versatz von ein
bis zwei Bildern ist ihm gleichgueltig, solange die Reihenfolge stimmt.

**Bleiben die Abdruecke aus, gibt der Decoder den Weg auf** (60 Bilder und 5
Sekunden ohne Antwort, `einfrieren::Zulauf`). Ohne das waere der schnelle Weg
still ungesichert, wenn der Renderer die Rechnung nicht ausfuehren kann.

**Wie er arbeitet, und warum nicht einfacher.** Naheliegend waere, FFmpegs
Decoder-Textur selbst zu teilen. Das geht aus zwei unabhaengigen Gruenden nicht:

* Der D3D11VA-Decoder liefert **nur einen Textur-Stapel** —
  `d3d11va_create_decoder` bricht ohne Array-Textur ab
  (`libavcodec/dxva2.c:482`), und `get_surface` prueft jedes Bild gegen genau
  diese eine Textur (`:761`). Der oft genannte Ausweg `initial_pool_size = 0`
  gilt fuer den **Encoder**-Pool des Sidecars, nicht fuer den Decoder.
* Einen geteilten Stapel nimmt D3D12 nicht an: `OpenSharedHandle` liefert
  `DXGI_ERROR_DEVICE_REMOVED`, das Geraet ist danach weg. Nicht abfangbar.

Deshalb kopiert die Bruecke die Schicht des Bildes **GPU-intern** in eine eigene,
einschichtige, teilbare Textur (`src/zerocopy/`), und der Renderer haengt DIESE
ueber `OpenSharedHandle` + `texture_from_raw` in wgpu-dx12 ein
(`src/render/fremdbild.rs`). Kein PCIe-Rueckweg, keine CPU-Kopie. Dieselbe
Bruecke faehrt `streaming/win-hq-sidecar/src/capture/wgc_d3d12.rs` in der
Gegenrichtung.

**Nur ueber D3D12.** `texture_from_d3d11_shared_handle` gibt es in wgpu-hal
29.0.4 ausschliesslich im Vulkan-Backend, `texture_from_raw` ausschliesslich im
dx12-Backend. Der Player faehrt unter Windows D3D12 (wegen HDR) — mit
`PULSE_PLAYER_BACKEND=vulkan` gibt es keinen Import, wohl aber den Rueckfall.

**Was noch daran haengt:**

- Ein Ring aus 24 geteilten Texturen, rund 160 MB bei 1080p10 und 265 MB bei
  1440p10 (`PULSE_PLAYER_ZEROCOPY_RING`). **Hier stand bis zum 2026-08-07
  „12 … Zwoelf, weil der Ausgabe-Takt allein vier Bilder haelt" — die
  Aufzaehlung war unvollstaendig:** sie vergass den Kanal zum Fenster-Faden
  (Fassungsvermoegen 8), dessen Bilder ebenfalls einen Ringplatz halten. Mit
  zwoelf war der Ring dauerhaft ueberbucht und der Decoder wartete in
  `AcquireSync` — damals ohne Zeitgrenze, gemessen als Stockungen von 0,7 bis
  2,3 Sekunden, die mit 24 Plaetzen verschwanden. Der Haushalt steht jetzt
  ausgeschrieben an `zerocopy::bruecke::ringgroesse` und haengt mit
  `app::takt::MAX_WARTEND` zusammen; **die beiden Zahlen sind nur gemeinsam zu
  aendern.**
- Ein CPU-Zaun nach der Kopie. Eine ueber `OpenSharedHandle` geoeffnete
  Ressource stellt keinen `IDXGIKeyedMutex` bereit, und wgpu 29 bietet keinen
  Warte-Aufruf auf seiner Warteschlange an. Das ist die naechste Stelle, an der
  sich etwas holen liesse.
- **Beide Wartepunkte haben seit dem 2026-08-13 eine Zeitgrenze** (Vorgabe
  250 ms, `PULSE_PLAYER_BRUECKE_WARTE_MS`). Vorher stand an beiden `INFINITE`,
  und beide liegen im Dekodier-Pfad der Sitzung: blockierte einer, stand das
  Bild ohne Meldung und ohne Rueckfall, weil der Einfrier-Waechter erst NACH
  einem fertig dekodierten Bild misst. Wird die Grenze gerissen, geht dieses
  eine Bild ueber den Hauptspeicher; passiert es dreimal in Folge, gibt die
  Bruecke auf und der Player liest dauerhaft zurueck. **Wer das anfasst, liest
  zuerst `anmelden` in `zerocopy/bruecke.rs`:** `AcquireSync` liefert
  `WAIT_TIMEOUT` als ERFOLGREICHEN HRESULT, der sichere Aufsatz der
  windows-Kiste verschluckt ihn, und wer ihn benutzt, schreibt in eine Flaeche,
  die der Renderer noch haelt.
- Die Textur des Decoders ist aufgerundet (bei AV1 auf Vielfache von 128, aus
  1080 werden 1152 Zeilen). Der Renderer schneidet beim Abtasten zu
  (`Bildform::nutzanteil`), statt einen Ausschnitt zu kopieren.
- Eine Bindegruppe je Ringplatz, nicht je Bild — sie liegt im
  `fremdbild`-Zwischenspeicher. Das ist der Unterschied zwischen 0,1-0,2 und
  0,0-0,1 ms Hochladen (eine Bindegruppe je Ringplatz und Sitzung statt einer
  je Bild, also vierundzwanzig statt sechzig je Sekunde bei 60 fps — vor dem
  2026-08-07 stand hier „zwoelf statt sechzig", damals war der Ring zwoelf
  gross).
- **NVIDIA und Intel sind ungemessen.** Der Rueckfall auf das Ruecklesen bleibt
  deshalb Pflicht und ist es auch: scheitert irgendetwas, steht eine Logzeile im
  Protokoll und der Player laeuft wie vorher.

## Aufbau

```
src/
├── main.rs        Einstiegspunkt: Fensterschleife (winit) + Tokio-Laufzeit
├── app/           Fenster- und Sitzungsverwaltung
│   ├── mod.rs     Sitzungen anlegen/schliessen, winit-Ereignisse
│   └── requests.rs  was die einzelnen RPC-Operationen bedeuten
├── rpc.rs         stdio-Transport (stdin lesen, stdout schreiben)
├── proto.rs       Protokolltypen, Optionen, Grenzen
├── whep.rs        WHEP-Aushandlung, liefert rohe RTP-Pakete
├── jitter.rs      Umsortieren nach Sequenznummer + zeitgesteuerte Freigabe
├── fernsteuerung/ Eingabe-Erfassung: die Seite des STEUERNDEN. Ein ZWEITER
│   │              Abnehmer der winit-Ereignisse neben egui, Standard AUS.
│   ├── mod.rs       Uebersetzung: welches Ereignis welchen Frame ergibt
│   ├── schlange.rs  Auslieferung: Zusammenfassen, Flutkontrolle, Takt
│   ├── rahmen.rs    Frame-Format Byte fuer Byte + Base64 + Rasten-Sammler
│   ├── tasten.rs    KeyCode -> Windows Scancode Satz 1
│   ├── bildlage.rs  Zeigerposition -> Anteil am BILD (Rand und Zoom heraus)
│   └── winit_abbild.rs  Knopf- und Rad-Zuordnung (Vorzeichen!)
├── depacket/      Zusammensetzen von Zugriffseinheiten
│   ├── mod.rs     H.264 (ueber das rtp-Crate) und Opus
│   └── av1.rs     AV1 — SELBST GESCHRIEBEN, s. u.
├── decode.rs      FFmpeg, Hardware zuerst
├── einfrieren.rs  erkennt den haengenden Decoder und staffelt die Abhilfe
│   ├── abdruck.rs    Fingerabdruck ueber die Ebenen im Hauptspeicher
│   ├── gpuabdruck.rs derselbe Nachweis fuer Bilder, die im Grafikspeicher
│   │                 bleiben: Rechenvorschrift, CPU-Zwilling, Rueckweg
│   └── messung.rs    Schalter des Pruefstands (im Betrieb aus)
├── stockung.rs    erkennt die haengende GRAFIKEINHEIT (das ist etwas anderes:
│                  der Decoder liefert, nur Sekunden zu spaet) und gibt den
│                  Hardware-Weg auf, bevor die Sitzung daran zerbricht
├── audio.rs       Opus-Decode + cpal-Ausgabe auf eigenem Thread
├── recorder.rs    Matroska-Mux ohne Neukodierung + Clip-Ringpuffer
├── mediasink.rs   buendelt Ton und Mitschnitt je Einheit
├── zerocopy/      das Bild im Grafikspeicher lassen (Windows: AMD/Intel)
│   ├── bruecke.rs   Ring geteilter D3D11-Texturen samt Zaun
│   ├── platz.rs     ein Ringplatz und wer ihn haelt (Lebensdauer-Regel)
│   ├── ffmpeg_geraet.rs  was FFmpeg an einem D3D11-Bild mitgibt
│   └── uebergabe.rs Naht zum Decoder
├── render/        wgpu-Darstellung
│   ├── mod.rs     Zeichnen, Bindegruppe, Ausgabe
│   ├── bildquelle.rs  woraus der Shader liest: eigene Ebenen oder Fremdtextur
│   ├── fremdbild.rs   geteilte Textur nach wgpu-dx12 einhaengen (Zero-Copy)
│   ├── abdruck.rs   Fingerabdruck auf der GPU rechnen und asynchron abholen
│   ├── abdruck.wgsl der Rechendurchgang ueber die Luma-Ebene
│   ├── setup.rs   Geraet, Pipeline, Wahl des Oberflaechenformats
│   ├── uniforms.rs  Uniform-Block als Bytes
│   └── shader.wgsl  YUV->RGB, Deband, Dither, Zoom
└── session.rs     verbindet alles je Sitzung
```

Die Reihenfolge WHEP -> Jitter -> Depacket -> Decode ist bewusst so aufgetrennt.
`webrtc::media::SampleBuilder` haette Umsortieren und Zusammensetzen in einem
Schritt erledigt, versteckt dabei aber genau die Pufferentscheidung, die hier
einstellbar sein soll.

### AV1: eigener Depacketizer

Das `rtp`-Crate (0.17) liefert fuer AV1 nur einen *Payloader*, keinen
Depacketizer. Da AV1 der Standard-Codec ist (`settings.svelte.ts` waehlt AV1,
sobald die GPU es encodieren kann), fuehrt kein Weg daran vorbei.

`depacket/av1.rs` implementiert den Aggregation-Header (Z/Y/W/N), das
Zusammensetzen ueber Paketgrenzen und — der unangenehme Teil — das
Wiedereinsetzen der `obu_has_size_field`-Groessenfelder, die das RTP-Format
weglaesst und FFmpeg erwartet.

Acht Unit-Tests decken das ab (einzelne OBUs, Fragmentierung, W=0 gegen W>0,
Temporal Delimiter, vorhandene Groessenfelder, verlorene Fortsetzungen).
**Gegen einen echten AV1-Stream ist es nicht geprueft** — das ist der erste
Punkt fuer den naechsten Testlauf.

### Mitschnitt: gegen echte Daten geprueft

Zwei Tests fahren einen echten Bitstrom durch den Rekorder und lesen die
erzeugte Datei wieder ein — sie pruefen Spur, Dauer und Dekodierbarkeit, nicht
nur die Dateigroesse. Sie brauchen eine Rohdatei und laufen sonst nicht:

```
ffmpeg -f lavfi -i testsrc2=s=640x360:r=30:d=3 -c:v libx264 \
  -bsf:v h264_mp4toannexb -f h264 fixture.h264
ffmpeg -f lavfi -i testsrc2=s=320x180:r=30:d=2 -c:v libsvtav1 \
  -preset 12 -f obu fixture.obu

PULSE_PLAYER_H264_FIXTURE=fixture.h264 cargo test h264_annexb -- --nocapture
PULSE_PLAYER_AV1_FIXTURE=fixture.obu   cargo test av1_obus   -- --nocapture
```

Diese Tests haben drei Fehler aufgedeckt, die kein Codelesen gefunden haette:
Matroska lehnte H.264 ohne `extradata` ab, AV1 landete in MPEG-TS als
unlesbares `bin_data`, und die Zeitstempel wurden nicht in die Zeitbasis des
Muxers umgerechnet — 90 Bilder landeten in 49 ms statt in drei Sekunden.

## Bauen und testen

**Zuerst: rustc >= 1.95.** Seit dem Sprung auf wgpu 30 / egui 0.36
(2026-08-07) baut die Kiste unter aelteren Fassungen nicht mehr — cargo lehnt
schon das Aufloesen ab („is not supported by the following packages"), es ist
also kein stiller Fehlschlag. Die Zahl steht in `Cargo.toml` unter
`rust-version` und ist dort begruendet. Wer auf einer Maschine mit aelterem
`stable` sitzt: `rustup update stable`, oder
`rustup toolchain install 1.97.1` und dann `cargo +1.97.1 …`, wenn die Vorgabe
fuer andere Arbeit stehenbleiben soll.

Die Auslieferwege sind davon **nicht** betroffen: das Player-Modul im
Flatpak-Manifest zieht sich seine eigene Toolchain, `win-build` und `mac-build`
nehmen die jeweils aktuelle stabile Fassung.

```
cd streaming/pulse-player
cargo test          # 326 Tests, keine Hardware noetig
cargo build --release
```

**Unter Windows braucht es `FFMPEG_DIR`, und zwar von Hand.** Der Nachbar
`win-hq-sidecar` setzt die Variable in seiner eigenen `.cargo/config.toml`;
diese Kiste hat keine, und ohne die Variable sucht `ffmpeg-sys-next` per
`pkg-config` — das es unter Windows regulaer nicht gibt. Die Fehlermeldung nennt
dann `pkg-config`, nicht FFmpeg, und zeigt damit in die falsche Richtung.

```powershell
$env:FFMPEG_DIR    = "$PWD\..\win-hq-sidecar\ffmpeg-dist\n8.1-lgpl-shared"
$env:LIBCLANG_PATH = 'C:\Program Files\LLVM\bin'
$env:PATH          = "$env:FFMPEG_DIR\bin;$env:PATH"   # <- fuer die LAUFZEIT
cargo test
```

**Die PATH-Zeile ist kein Beiwerk.** `FFMPEG_DIR` sagt nur, wogegen gelinkt
wird; zur Laufzeit sucht Windows die DLLs erneut, und zwar zuerst neben der
`.exe`, die gerade startet. Fehlen sie dort und im PATH, stirbt das Programm mit
`STATUS_DLL_NOT_FOUND` (`0xC0000135`), **bevor eine Zeile Code laeuft** — bei
`cargo test` als nacktes „test failed" ohne Grund.

Seit dem 2026-08-18 hat diese Kiste dafuer ein **`build.rs`** wie der Nachbar
`win-hq-sidecar`: es kopiert die DLLs aus `$FFMPEG_DIR/bin/` neben die gebauten
Binaerdateien (`target/{profile}/` samt `examples/` und `deps/`). Der gebaute
Player laeuft damit auch dann, wenn ihn jemand ohne vorbereiteten PATH startet
— genau der Fall in der Dev-Sitzung, wo Electron ihn selbst startet und ihm
nichts mitgibt. Die PATH-Zeile bleibt trotzdem sinnvoll: sie greift auch beim
allerersten Lauf in einem frischen Baum, in dem die Zielverzeichnisse noch gar
nicht existieren.

**Warum das nicht einfach in eine `.cargo/config.toml` wandert:** deren
`[env]`-Block gilt fuer JEDE Plattform und laesst sich nicht auf Windows
einschraenken. Unter Linux und macOS wuerde er `FFMPEG_DIR` auf einen Pfad
setzen, den es dort nicht gibt, und den bis dahin funktionierenden Weg ueber
`pkg-config` abschneiden. Ein Eintrag, der zwei Plattformen bricht, um einer
eine Zeile zu sparen, ist kein guter Tausch.

**Schlaegt `depacket::tests::repro_3_stapa_ueberzaehliges_byte` mit „index out
of bounds" im `vendor/`-Baum fehl, ist nicht der Test kaputt, sondern der
Baum veraltet**: `vendor/webrtc-rs/` ist gitignored und wird von
`scripts/bootstrap-webrtc.sh` hergestellt, und dieser Test haengt an
`patches/0003-h264-stapa-bounds-check.patch`. Wer seinen Baum vor diesem Patch
geholt hat, hat ihn nicht drin. Abhilfe: Skript erneut laufen lassen, oder
`cd vendor/webrtc-rs && git apply ../../patches/0003-*.patch`. Am 2026-08-11 auf
der Windows-Maschine genau so aufgeschlagen und eine Weile fuer eine Regression
gehalten.

**Den Decoder von aussen festlegen** (`PULSE_PLAYER_DECODER`, s.
`src/decoderwahl.rs`) — Komma-Liste in Probierreihenfolge, `name`,
`name+hw` (plattform-eigener hwaccel: D3D11VA/VAAPI) oder `name+cuda`:

```
PULSE_PLAYER_DECODER=av1+hw        # D3D11VA statt av1_cuvid -> Zero-Copy-Weg
PULSE_PLAYER_DECODER=libdav1d      # Software, zum Gegenmessen
```

Trifft die Vorgabe keinen Kandidaten, scheitert der Decoder **laut** statt auf
die volle Liste zurueckzufallen — ein stiller Rueckfall lieferte ein sauberes
Messergebnis vom falschen Weg.

Rauchtest ohne Stream (oeffnet kein Fenster):

```
printf '{"op":"health","id":1}\n{"op":"shutdown","id":2}\n' | ./target/release/pulse-player
```

Mit echtem Stream (oeffnet ein Fenster):

```
printf '{"op":"open","id":1,"url":"https://…/whep/…?token=…"}\n' | ./target/release/pulse-player
```

## Lizenz

Die Crate selbst faellt unter die Client-Lizenz des Repos (**Pulse Client
License 1.0**, siehe `../LICENSE`). Hier stand bis 2026-08-04 „PolyForm
Perimeter" — das Projekt ist am 2026-07-29 auf eigene Lizenztexte gewechselt,
weil PolyForm ausdruecklich Aenderungen und Weitergabe erlaubt und damit genau
das gestattet haette, was hier untersagt sein soll. Fuer Abhaengigkeiten gilt:

- **Kein GPL-Code** darf hier hineingelinkt werden. Das kollidiert hart mit der
  Client-Lizenz.
- **FFmpeg muss LGPL-konfiguriert und dynamisch gelinkt sein.** Die System-FFmpeg
  vieler Distributionen ist mit `--enable-gpl` gebaut (auf der Dev-Maschine
  meldet das Arch-Paket GPL-3.0-only) und taugt deshalb **nur zur lokalen
  Entwicklung**. Ausgelieferte Builds folgen dem Vorbild der bestehenden
  Sidecars: `win-hq-sidecar` nutzt die vendorte BtbN-LGPL-Distribution,
  `mac-hq-sidecar` ein selbst gebautes LGPL-FFmpeg.
- `wgpu`, `winit`, `webrtc-rs`, `cpal`: MIT/Apache-2.0. `dav1d`: BSD.
  Ueber `webrtc-rs` kommt zwingend `rustls` und damit `aws-lc-rs`/`aws-lc-sys`
  (ISC, Apache-2.0, MIT, BSD-3-Clause — alle permissiv).

Alles Ausgelieferte gehoert nach `THIRD-PARTY-NOTICES.md` und auf die
Drittanbieter-Seite im Web.

## Naechste Schritte

1. Gegen einen echten Stream testen — zuerst AV1, dort ist das Risiko am
   groessten. Dabei gleich die Lippensynchronitaet pruefen: Bild kommt aus
   diesem Player, Ton weiterhin aus dem Browser-Pfad.
2. Lippensynchronitaet messen: Ton laeuft jetzt durch den Player, aber die
   Synchronisierung ist eine Puffer-Naeherung, keine Zeitstempel-Kopplung.
3. Die Render-Etappe messen: Glass-to-Glass durch diesen Player gegen den
   `<video>`-Weg. Das ist die Zahl, die in
   `docs/2026-07-21-remote-control-latenz-messung.md` §2.4 noch als Schaetzung
   steht, und sie entscheidet, ob der Player auch fuer die Fernsteuerung
   der richtige Weg ist.
4. **Erledigt am 2026-08-06 nachts: Zero-Copy ist die Vorgabe.** Hier stand
   „was ihn noch als Schalter festhaelt, ist der Einfrier-Waechter — er braucht
   die Ebenen im Hauptspeicher. Der Schritt dorthin ist, seinen Fingerabdruck
   auf der GPU zu bilden (Rechen-Durchgang ueber die Luma-Ebene, 8 Byte
   zurueck)." Genau das ist gebaut (s. „Zero-Copy" oben), und der Schalter zeigt
   jetzt andersherum.

   **Die eigene Abgabe an die Warteschlange ist am 2026-08-06 weggefallen.**
   Hier stand „der Fingerabdruck kostet rund 0,3 ms je Bild im Posten
   ‚hochladen', weil er eine eigene Abgabe an die Warteschlange braucht — in
   den Zeichendurchgang gefaltet waere er billiger". Genau das ist gemacht
   (`render::abdruck::im_zeichendurchgang`). Was es gebracht hat, ehrlich
   gemessen (drei Paare, abwechselnd, HDR ueber den Messstand): der Posten
   „hochladen" faellt von **0,5 auf 0,0 ms**, der Posten „ausgeben" steigt von
   **0,4 auf 0,8 ms** — die Arbeit ist also groesstenteils **umgezogen**, netto
   bleiben rund **0,1 ms je Bild**. Die erhoffte Entlastung durch die
   weggefallene Serialisierung zweier Abgaben zeigt sich in diesen Zahlen
   nicht. Messakte:
   `streaming/testbench/profiles/leistung-2026-08-06-vier-befunde.json`.

   Und die **Latenz-Sonde** misst auf diesem Weg weiterhin nicht; sie sagt es
   jetzt, ersetzt ist sie damit nicht.

   **Hier stand, Zero-Copy sei die Abhilfe gegen die Stockung. Das ist
   widerlegt:** ohne Ruecklesen bleiben die Stockungen in derselben Groesse
   stehen, die Zeit steht dann im eigenen Zaun. Es haengt die Grafikeinheit,
   nicht der Weg des Bildes. Der Rueckfall auf Software bleibt die einzige
   bekannte Abhilfe.

   Ebenfalls offen: NVIDIA und Intel. Auf NVIDIA ist selbst der Import
   ungeprueft, und der Vulkan-Weg kam dort schwarz an.
5. macOS bauen und pruefen. **Windows ist am 2026-08-05 erledigt** — gebaut,
   gegen die echte Kette geprueft (H.264 und AV1, 8 und 10 bit, jeweils
   `*_cuvid` in Hardware) und im Installer. Hier stand vorher „Windows und
   macOS"; nur macOS ist offen.
