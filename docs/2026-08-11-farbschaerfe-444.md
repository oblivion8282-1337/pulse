# Volle Farbauflösung (4:4:4) in der Pulse-Streaming-Kette

**Untersuchung vom 2026-08-11 — reine Analyse, kein Code geändert.**
Anlass: `docs/plans/2026-08-11-fernsteuerung-neubewertung.md`. Für die Fernsteuerung
ist nicht Zuschauen der Maßstab, sondern Arbeiten am fremden Rechner. Die Frage
war, ob unsere Kette 4:4:4 trägt, auf welchem Weg und zu welchem Preis.

Gemessen auf der Entwicklungsmaschine (AMD Radeon 780M, Mesa 26.1.5, Fedora,
libva 2.23, FFmpeg 8.x/Lavc 62, Chromium 1217 aus dem Playwright-Cache).
Alles, was hier als Messung steht, ist auf dieser Maschine tatsächlich gelaufen.
Windows/NVIDIA/AMF war nicht erreichbar — dort steht ausdrücklich „ungeprüft".

---

## 0. Die Kurzfassung

**4:4:4 ist technisch möglich, aber nicht auf unserer Hardware und nicht ohne
den Verlust der Hardware-Kodierung.** Der überraschende Teil: die beiden Glieder,
bei denen man das Scheitern erwartet hätte — Transport und Browser — können es.
Gescheitert wird am **Encoder**, und dort endgültig.

Der zweite, für die Empfehlung wichtigere Befund: **4:2:0 beschädigt fast
ausschließlich farbigen Text.** Grauer und weißer Text — Terminal, Dokument,
Dateimanager, der Großteil einer Fernwartungssitzung — kommt durch 4:2:0
praktisch unbeschädigt. Der Leidtragende ist die Syntaxhervorhebung.

---

## 1. Geht es? Die Kette Glied für Glied

Legende: **ja** = gemessen und funktioniert · **nein** = gemessen und
ausgeschlossen · *ungeprüft* = Recherche/Codelage, keine Hardware verfügbar.

| Glied der Kette | H.264 | AV1 | HEVC | Beleg |
|---|---|---|---|---|
| **Encoder Linux VAAPI (AMD 780M)** | **nein** | **nein** | **nein** | gemessen, §2.1 |
| Encoder Linux NVENC | *ungeprüft (wahrsch. ja)* | *ungeprüft (wahrsch. nein)* | *ungeprüft (ja)* | §2.2 |
| Encoder Windows NVENC | *ungeprüft (wahrsch. ja)* | *ungeprüft (wahrsch. nein)* | *ungeprüft (ja)* | §2.2 |
| Encoder Windows AMD (AMF/D3D12VA) | *ungeprüft (wahrsch. nein)* | *ungeprüft (nein)* | *ungeprüft (nein)* | §2.2 |
| Encoder Windows CPU-Rückfall | **nein** (kein SW-Encoder gelinkt) | **nein** | **nein** | §2.3 |
| Encoder macOS VideoToolbox | *ungeprüft (nein)* | *ungeprüft (nein)* | *ungeprüft (nein)* | §2.4 |
| Software-Encoder (libx264, hier gemessen) | **ja** | — | — | §2.5 |
| **Unser WHIP-Sendeweg (SDP)** | **nein**, heute nicht formulierbar | **nein**, `profile-id=0` | — | §3.1 |
| RTP-Paketierer (H.264, eigener AV1) | **ja**, formatblind | **ja**, formatblind | — | §3.2 |
| **MediaMTX** | **ja** (reicht durch) | **ja** | **ja** | §3.3 |
| RTMPS/FLV | ja (formal) | ja (Enhanced-RTMP) | ja | §3.4 |
| **Browser-Empfang (Chromium 150)** | **ja**, `f4001f` | **ja**, `profile=1` | — | **gemessen**, §4.1 |
| Browser-WHEP-Client (`whep.ts`) | **ja** (filtert nichts) | **ja** | — | §4.1 |
| **Nativer Player (`pulse-player`)** | **nein** (Sitzungsabbruch) | **nein** | — | §4.2 |
| Player Zero-Copy-Brücken | **nein** (fällt sauber auf Kopie zurück) | **nein** | — | §4.2 |

**Das Nadelöhr ist eindeutig der Encoder.** Alles dahinter ließe sich öffnen;
Transport und Browser sind bereits offen.

---

## 2. Die Encoder

### 2.1 Linux/VAAPI auf AMD — gemessen, eindeutig nein

`vainfo` listet für **jeden** Encode-Einstiegspunkt der 780M ausschließlich
4:2:0-Formate:

```
VAProfileH264High/VAEntrypointEncSlice
    VAConfigAttribRTFormat : VA_RT_FORMAT_YUV420
                             VA_RT_FORMAT_YUV420_10
                             VA_RT_FORMAT_YUV420_10BPP
VAProfileAV1Profile0/VAEntrypointEncSlice
    VAConfigAttribRTFormat : VA_RT_FORMAT_YUV420
                             VA_RT_FORMAT_YUV420_10
                             VA_RT_FORMAT_YUV420_10BPP
```

`VA_RT_FORMAT_YUV444` und `VA_RT_FORMAT_RGB32` kommen im ganzen Dump **genau
einmal** vor — unter `VAProfileNone/VAEntrypointVideoProc`, also beim
Nachbearbeiter (Skalieren/Farbraum), nie bei einem Encoder.

Gegenprobe mit echtem Encode-Versuch, alle drei Codecs:

```
$ ffmpeg -f lavfi -i testsrc2 -vf format=yuv444p,hwupload -c:v h264_vaapi ...
[h264_vaapi @ …] No usable encoding profile found.
$ … -c:v av1_vaapi  →  No usable encoding profile found.
$ … -c:v hevc_vaapi →  No usable encoding profile found.
```

Dazu die Profil-Lage grundsätzlich: **AV1 Profile 0 (Main) kann definitionsgemäß
kein 4:4:4** — dafür bräuchte es Profile 1 (High). Die Karte bietet AV1-Encode
ausschließlich als Profile 0 an. Bei H.264 böte nur `High 4:4:4 Predictive`
(profile_idc 244) 4:4:4; die Karte kann bis `High` (100).

**Nebenbefund, unabhängig von 4:4:4, aber meldenswert:** ein `av1_vaapi`-Lauf auf
Standbild-Eingabe mit `-g 9999` hat den Videoblock der GPU zum Absturz gebracht:

```
amdgpu: The CS has cancelled because the context is lost. This context is guilty of a hard recovery.
amdgpu 0000:c5:00.0: Starting vcn_unified_0 ring reset
amdgpu 0000:c5:00.0: Ring vcn_unified_0 reset succeeded
```

Der Bildschirm war nicht betroffen (nur der VCN-Block, sauber zurückgesetzt), und
ich habe den Weg danach nicht erneut gereizt. Ob das im echten Sidecar-Betrieb
auftreten kann, ist **offen** und wäre eine eigene Untersuchung wert.

### 2.2 NVENC und AMF — nicht messbar, hier nur Recherche

Kein Zugriff auf NVIDIA- oder Windows-AMD-Hardware. Nach Herstellerangaben
(NVIDIA Video Codec SDK Support-Matrix, AMD AMF-Dokumentation) gilt, **ungeprüft**:

* **NVENC H.264:** unterstützt `High 4:4:4 Predictive` seit Maxwell 2. Gen. Das
  ist der einzige Weg in unserem Codec-Paar, der auf real verbreiteter Hardware
  4:4:4 in Hardware könnte — und genau der Weg, den Sunshine für seinen
  4:4:4-Modus nutzt.
* **NVENC HEVC:** 4:4:4 seit Pascal.
* **NVENC AV1** (Ada/Blackwell): nach Support-Matrix **kein** 4:4:4 — AV1-Encode
  ist dort 4:2:0, 8/10 bit. Unser Hauptcodec fiele also auch auf NVIDIA aus.
* **AMD AMF/VCN:** kein 4:4:4-Encode für H.264, HEVC oder AV1. Meine
  VAAPI-Messung an derselben VCN-Generation (§2.1) stützt das unabhängig, ist
  aber kein Beweis für den Windows-Treiber.
* **Intel QSV:** HEVC 4:4:4 auf neueren Generationen; H.264 4:4:4 nein.

**Konsequenz, falls das weiterverfolgt wird:** 4:4:4 wäre ein reiner
NVIDIA-H.264-Sonderweg. Auf AMD — der Hardware, auf der hier entwickelt wird und
auf der die HDR-/AV1-Arbeit des letzten Monats aufsetzt — gibt es ihn nicht.

### 2.3 Der Windows-CPU-Rückfall kann es nicht ersetzen

Naheliegender Gedanke: wenn die Hardware nicht kann, nimm den CPU-Weg. Geht
nicht — der „CPU-Rückfall" ist kein Software-Encoder. Er erzeugt lediglich
NV12-Bilder im Hauptspeicher und schiebt sie in **denselben Hardware-Encoder**.
Und das mitgelieferte FFmpeg enthält bewusst keinen Software-Encoder:

```
# streaming/win-hq-sidecar/scripts/fetch-ffmpeg.ps1
# LGPL, ohne `--enable-gpl`/`--enable-nonfree`/libx264/libx265.
```

> **Nachtrag 2026-08-21:** Der Block stand ursprünglich in
> `scripts/build-ffmpeg-patched.ps1:217`. Dieses Skript gab es nur, weil das
> mitgelieferte FFmpeg für den Intra-Refresh gepatcht werden musste; mit der
> Betriebsart ist es entfallen. Der Sidecar holt seither das unveränderte
> BtbN-Paket über `fetch-ffmpeg.ps1` — die Lizenzregel ist dieselbe geblieben.

Das ist **kein Versehen, sondern die Lizenzregel aus `CLAUDE.md`** („FFmpeg
überall LGPL und dynamisch gelinkt — so lassen"). libx264 ist GPL-3.0; es
aufzunehmen kollidiert frontal mit der Pulse Client License, die Ändern und
Weitergeben untersagt. Ein 4:4:4-Software-Weg auf Windows kostet also nicht nur
Rechenzeit, sondern eine **Lizenzentscheidung**.

### 2.4 macOS/VideoToolbox

Der Sidecar reicht BGRA hinein und überlässt dem Treiber alles Weitere
(`mac-hq-sidecar/src/encode/hw.rs:56`), setzt kein Profil, hat keinen 10-bit-Weg.
VideoToolbox bietet 4:4:4-Encode nach Apple-Dokumentation nicht für H.264/AV1 an.
**Ungeprüft**, aber ohne erkennbaren Ansatzpunkt.

### 2.5 Was Software wirklich kostet — gemessen

`libx264` kann `High 4:4:4 Predictive`, hier zur Bezifferung des Preises
gemessen (nicht als Vorschlag — siehe Lizenz oben).

Durchsatz auf **bewegtem** Text (scrollendes Codefenster; Standbild macht x264
unrealistisch schnell), 16 CPU-Kerne, `-crf 20`:

| Auflösung | Format | Preset | Durchsatz |
|---|---|---|---|
| 1920×1080 | 4:2:0 | veryfast | 221,7 fps |
| 1920×1080 | 4:4:4 | veryfast | 178,7 fps |
| 1920×1080 | 4:4:4 | ultrafast | 280,1 fps |
| 2560×1440 | 4:2:0 | veryfast | 148,1 fps |
| 2560×1440 | **4:4:4** | **veryfast** | **93,1 fps** |
| 2560×1440 | 4:4:4 | ultrafast | 145,8 fps |

1440p60 in 4:4:4 ist mit `veryfast` machbar, verbrennt aber grob zwei Drittel
einer 16-Kern-CPU **dauerhaft und im Hintergrund** — während der Nutzer auf
genau dieser Maschine arbeiten soll. Das ist der Gegenentwurf zum ganzen Zweck
des HQ-Wegs (GPU-Encode, CPU frei). Auf schwächeren Maschinen fällt es aus.

---

## 3. Der Transportweg — trägt 4:4:4, aber unser Angebot formuliert es nicht

### 3.1 Zwei harte Sperren, beide im eigenen Code

```rust
// streaming/pulse-whip/src/sdp.rs:136-140 (seit 2026-08-20 gemeinsame Crate
// aller drei Sidecars; damals noch in win-/linux-hq-sidecar/src/whip/sdp.rs)
sdp_fmtp_line: format!(
    "level-asymmetry-allowed=1;packetization-mode=1;\
     profile-level-id=6400{:02x}",
    h264_stufe(breite, hoehe, fps)
),
```
`64` = `profile_idc 100` = High = 4:2:0. Für 4:4:4 müsste dort `f4` stehen.

```rust
// streaming/pulse-whip/src/sdp.rs:157
sdp_fmtp_line: "profile-id=0".to_owned(),   // AV1 Main = nur 4:2:0
```

**Die tiefere Sperre liegt eine Ebene darunter** und ist beim Planen wichtig:
das tatsächliche SDP-Angebot stammt gar nicht aus `sdp.rs`, sondern aus
webrtc-rs' Default-Tabelle:

```rust
// …/whip/mod.rs:231-232
let mut media = MediaEngine::default();
media.register_default_codecs()?;
```

Diese Tabelle kennt für AV1 nur `profile-id=0` und für H.264 nur `42…`/`64…`.
Ein 4:4:4-Angebot ist damit **heute nicht formulierbar** — es bräuchte
`MediaEngine::new()` plus eigene `register_codec`-Aufrufe. Das Muster existiert
im Haus bereits (`pulse-player/src/whep.rs:369-386` meldet FlexFEC von Hand an),
ist also bekannt, aber es ist Arbeit.

### 3.2 Die Paketierer sind kein Hindernis

Der H.264-Payloader arbeitet auf NAL-Ebene, unser eigener AV1-Paketierer
(`whip/av1.rs`) ausschließlich auf OBU-Typen — er liest den Profilwert im
Sequenzkopf nie. Beide trügen 4:4:4 unverändert.

### 3.3 MediaMTX reicht durch

`infra/prod/mediamtx.yml` enthält keine Codec-, Profil- oder
Pixelformat-Angabe, der Pfadblock ist leer; kein Transcoding. Die Fork-Patches
fassen AV1-OBUs an (TempDelim), rechnen aber nur mit OBU-Typen, profilunabhängig.

*Einschränkung:* Der MediaMTX-Quelltext liegt nicht im Repo (wird zur Bauzeit
geklont). Welche fmtp-Zeile MediaMTX in der **WHEP-Antwort** anbietet, ist damit
hier nicht verifizierbar und müsste am laufenden Server nachgesehen werden —
das wäre die zweite Prüfstelle eines 4:4:4-Vorhabens.

### 3.4 RTMPS/FLV

FLV beschränkt die Farbabtastung nicht, nur die Codec-Tags. Formal liefe ein
4:4:4-H.264-Bitstrom durch. Praktisch ist RTMPS bei uns ohnehin nur noch der
Weg für „AV1 ohne Intra-Refresh" und hat keinen RTCP-Rückkanal — für
Fernsteuerung ist er der falsche Weg.

> **Nachtrag 2026-08-19:** Der Halbsatz „nur noch der Weg für AV1 ohne
> Intra-Refresh" stimmt seit dem 2026-08-18 nicht mehr. Die Oberfläche wählt
> **immer** WHIP, ohne Fallunterscheidung nach Codec oder Betriebsart
> (`stream/settings.svelte.ts::pushProtokoll`); RTMPS bleibt nur serverseitig
> bestehen, für Netze, die UDP sperren. Der Schluss dieses Abschnitts wird
> davon nicht berührt — er wird sogar stärker: RTMPS kommt für einen normalen
> Stream gar nicht mehr vor.
>
> **Nachtrag 2026-08-21:** Die Betriebsart „Intra-Refresh" gibt es seither gar
> nicht mehr; „AV1 ohne Intra-Refresh" beschreibt heute schlicht jeden Stream.

---

## 4. Der Empfänger

### 4.1 Der Browser kann es — gemessen, und das war die Überraschung

Chromium 150 (Playwright-Build), headless abgefragt:

```
RTCRtpReceiver.getCapabilities("video"):
  video/H264 | …;profile-level-id=f4001f     ← f4 = High 4:4:4 Predictive
  video/AV1  | level-idx=5;profile=1;tier=0  ← AV1 Profile 1 = 4:4:4
  video/VP9  | profile-id=1                  ← VP9 4:4:4
  video/VP9  | profile-id=3                  ← VP9 4:4:4, 10 bit
```

Und `VideoDecoder.isConfigSupported` meldet für **alle** geprüften
4:4:4-Kennungen `supported: true` (`av01.1.05M.08`, `av01.1.05M.10`,
`avc1.f40028`, `avc1.7a0028`, `vp09.01.10.08`, `vp09.03.10.10`).

Unser WHEP-Client (`web/src/lib/stream/whep.ts`) filtert nichts — er legt nackte
`recvonly`-Transceiver an; das einzige SDP-Munging betrifft Opus-Stereo. Das
Video-Angebot ist also exakt Chromiums Default, und der enthält 4:4:4 bereits.

**Der Browser ist damit nicht das Nadelöhr.** Einschränkung: `isConfigSupported`
ist in Chromium bekanntlich großzügig, und das Dekodieren liefe nach unserer
eigenen Messreihe (`docs/2026-08-03-chromium-webrtc-decode-messung.md`) ohnehin
**in Software** — 4:4:4 verteuerte das zusätzlich. Dass die Aushandlung klappt,
ist gemessen; dass ein echter 4:4:4-Strom im Browser flüssig ankommt, ist es nicht.

### 4.2 Der native Player kann es heute nicht — aber der Umbau ist klein

Die Formatweiche kennt vier Formate, alle 4:2:0:

```rust
// streaming/pulse-player/src/decode.rs:1906-1910
Pixel::YUV420P     => (PixelLayout::Planar420,   false, 3),
Pixel::YUV420P10LE => (PixelLayout::Planar420,   true,  3),
Pixel::NV12        => (PixelLayout::BiPlanar420, false, 2),
Pixel::P010LE      => (PixelLayout::BiPlanar420, true,  2),
```

Ein 4:4:4-Strom dekodiert, wird hier abgewiesen und reißt nach 60 unbrauchbaren
Bildern die Sitzung ab — der Fall ist im Code sogar namentlich dokumentiert.

**Die gute Nachricht: der Shader müsste nicht angefasst werden.** `sample_yuv`
tastet Chroma mit demselben normalisierten `uv` ab wie Luma; die halbe Auflösung
steckt allein in der Texturgröße. Sind die U/V-Texturen gleich groß, funktioniert
der bestehende WGSL-Code unverändert. Nötig wären rund sieben Rust-Stellen
(`PixelLayout::Planar444`, die Formatweiche, die `div_ceil(2)`-Zeilen in
`decode.rs`/`bildquelle.rs`, `farbe.rs::ebenenformate`/`scales`/`narrow_plane_into`).

Der Zero-Copy-Weg fiele automatisch aus (jede der drei Brücken lehnt alles außer
NV12/P010 ab und fällt sauber auf den Hauptspeicherweg zurück) — das kostet die
dort bezifferten 2,8–5,2 ms je Bild.

### 4.3 HEVC als Ausweg?

Technisch böte HEVC 4:4:4 auf NVIDIA und Intel. Aber:

* Auf unserer AMD-Hardware **nein** (gemessen: nur `HEVCMain`/`HEVCMain10`, beide 4:2:0).
* Chromium bietet HEVC im WebRTC-Empfang **nicht** an (in der obigen Liste fehlt es).
* Und die Lizenzfrage ist bei uns **ungeklärt**: HEVC trägt aktive Patentpools
  (Access Advance, Via LA) mit Stückzahl-Lizenzgebühren. Weder `LICENSE` noch
  `THIRD-PARTY-NOTICES.md` nehmen dazu Stellung. Das ist keine technische, sondern
  eine geschäftliche Entscheidung und müsste vor jeder HEVC-Auslieferung fallen.

HEVC ist damit **kein gangbarer Weg** — er scheitert schon am Browser und an
unserer Hardware, bevor die Lizenzfrage überhaupt relevant wird.

---

## 5. Der Preis — und der Deckel, den keine Bitrate hebt

### 5.1 Der zentrale Beleg: Bitrate hilft dem Chroma nicht

Testbild: Code-Editor-Fenster, farbiger Text auf dunklem Grund, 1920×1080.
Gemessen wird gegen das RGB-Original, beide Seiten nach `yuv444p` gehoben —
sonst definiert man den Chroma-Verlust per Vergleichsraum weg.

`h264_vaapi` (unser echter Linux-Weg), Bitrate von 2 auf 40 Mbit/s:

| Bitrate | PSNR Luma (y) | PSNR Chroma (u) | PSNR Chroma (v) |
|---|---|---|---|
| 4 000 kbit/s | 54,30 dB | 25,820 dB | 26,958 dB |
| 40 000 kbit/s | 61,63 dB | 25,825 dB | 26,963 dB |
| **Gewinn durch 10× Bitrate** | **+7,3 dB** | **+0,005 dB** | **+0,006 dB** |

**Die zehnfache Bitrate verbessert die Farbe um fünf Tausendstel Dezibel.**
Der Gesamtwert läuft dabei exakt in den Deckel der reinen Unterabtastung:

| | PSNR (Mittel, RGB) |
|---|---|
| Reine Umrechnung RGB→4:2:0→RGB, **kein Encoder** | 22,7589 dB |
| `h264_vaapi` 4:2:0 @ 2 Mbit/s | 22,7343 dB |
| `h264_vaapi` 4:2:0 @ 40 Mbit/s | **22,7587 dB** |
| Reine Umrechnung RGB→4:2:2→RGB | 22,8963 dB |
| Reine Umrechnung RGB→**4:4:4**→RGB | **67,9665 dB** |

Bei 40 Mbit/s ist der Encoder bis auf zwei Zehntausendstel Dezibel an der
Unterabtastungsgrenze angekommen. **Der Verlust ist strukturell, nicht ein
Bitratenproblem.** Und 4:2:2 kauft praktisch nichts (+0,14 dB), weil Text in
beiden Richtungen dünn ist.

Zur Einordnung: 4:4:4 statt 4:2:0 sind hier **rund 45 dB** Unterschied. So groß
werden Unterschiede in der Bildtechnik selten.

### 5.2 Was 4:4:4 an Daten kostet — deutlich weniger als „doppelt"

Der Reflex „4:4:4 verdoppelt die Farbdatenmenge" stimmt für die *rohen* Ebenen,
nicht für den *komprimierten* Strom: die Chroma-Ebenen von Text sind überwiegend
flach und komprimieren hervorragend.

`libx264` auf bewegtem Text, bei gleicher Vorgabe:

| Vorgabe | 4:2:0 tatsächlich | 4:4:4 tatsächlich | Aufschlag |
|---|---|---|---|
| Standbild @ 4 000 kbit/s | 0,73 Mbit/s | 0,93 Mbit/s | **+27 %** |
| bewegt, `-crf 18` | 1,21 Mbit/s | 0,88 Mbit/s | **−27 %** |
| bewegt, `-crf 23` | 0,72 Mbit/s | 0,68 Mbit/s | −6 % |

Bei fester Qualitätsvorgabe ist 4:4:4 auf Textinhalt sogar **sparsamer** — die
sauberen Farbkanten kosten weniger Bits als die Artefakte, die 4:2:0 erzeugt
und die der Encoder anschließend teuer kodieren muss. Realistisch ist ein
Aufschlag von **null bis dreißig Prozent**, nicht hundert.

### 5.3 Aber: 4:4:4 ist bei knapper Bitrate schädlich

Wichtige Gegenprobe, damit die Empfehlung nicht zu freundlich ausfällt. Bei
fester CBR-Vorgabe auf bewegtem Text:

| Vorgabe | Format | Luma (y) | Chroma (u) | Mittel |
|---|---|---|---|---|
| 1 500 kbit/s | 4:2:0 | **32,27 dB** | 23,60 dB | **25,56 dB** |
| 1 500 kbit/s | 4:4:4 | 26,90 dB | 23,74 dB | 24,94 dB |
| 4 000 kbit/s | 4:2:0 | 32,87 dB | 23,62 dB | 25,62 dB |
| 4 000 kbit/s | 4:4:4 | 31,06 dB | 28,50 dB | **29,52 dB** |
| 10 000 kbit/s | 4:2:0 | 32,89 dB | 23,63 dB | 25,63 dB |
| 10 000 kbit/s | 4:4:4 | 32,89 dB | **30,93 dB** | **31,81 dB** |

Bei 1,5 Mbit/s **verliert** 4:4:4: die Farbebenen nehmen dem Luma die Bits weg,
die Schärfe fällt von 32,3 auf 26,9 dB — und Schärfe ist das, was Text lesbar
macht. Der Umschlagpunkt liegt hier bei grob 4 Mbit/s für 1080p60. Ein pauschal
eingeschaltetes 4:4:4 würde Nutzer mit schmaler Leitung schlechter stellen.

### 5.4 Und der entscheidende Vorbehalt: 4:2:0 trifft nur **farbigen** Text

Zwei Testbilder, identischer Text, einmal einfarbig grau, einmal
syntaxhervorgehoben. Reine Unterabtastung, kein Encoder:

| Textart | 4:2:0 | 4:4:4 | Verlust durch 4:2:0 |
|---|---|---|---|
| **grau/weiß auf dunkel** | 62,08 dB | 69,20 dB | **7,1 dB** |
| **farbig (Syntax)** | 35,92 dB | 64,14 dB | **28,2 dB** |

62 dB ist visuell verlustfrei. **Grauer Text nimmt durch 4:2:0 praktisch keinen
Schaden** — er ist unbunt, U und V sind überall gleich, es gibt nichts zu
verlieren. Der gesamte Effekt, den Sunshines Entwickler beschreibt, hängt an
**farbigem** Text.

Der Sichtvergleich (`vergleich_zoom.png`, 4-fach vergrößert, oben Original,
Mitte 4:2:0, unten 4:4:4) bestätigt das: Blau und Rot verschmieren sichtbar,
Grün und Weiß bleiben sauber. Grün deshalb, weil es in der Luma-Formel mit
0,7152 gewichtet ist und damit fast vollständig im unbeschädigten Luma steckt.

**Für die Fernsteuerung heißt das:** Terminal, Dateimanager, Browser mit
schwarzem Text auf weiß, Office — alles unproblematisch. Eine
syntaxhervorgehobene Codedatei oder eine farbige Oberfläche — dort sitzt der
Schaden.

---

## 6. Die Alternativen, geordnet nach Wirkung je Aufwand

### Platz 1 — Auflösung am gesteuerten Rechner umstellen (Parsec/Sunshine-Weg)

**Wirkung: hoch. Aufwand: mittel. Kein Encoder-, Transport- oder Playerumbau.**

Der Grund, warum Parsec und Sunshine das tun, ist genau unser Problem: Schärfe
steckt im Luma, und Luma ist unbeschädigt. Wer die Quelle von 4K auf die
Fenstergröße des Steuernden bringt, bekommt Text mit voller Luma-Auflösung
1:1 auf den Bildschirm, statt ihn zweimal zu skalieren. Das schlägt 4:4:4 bei
grauem Text um Längen und wirkt bei farbigem zusätzlich.

Zweiter, gleich großer Vorteil: es senkt die Datenmenge, statt sie zu erhöhen —
und behebt damit den in §5.3 gemessenen Nachteil, statt ihn zu verschärfen.

Der Aufwand liegt nicht in der Kodierung, sondern in der Plattformarbeit
(Auflösung des Hosts setzen und zuverlässig zurücksetzen, virtuelle Anzeige,
Wiederherstellung nach Absturz). Es ist die Alternative mit dem besten
Verhältnis — und die einzige, die auf **allen** Plattformen und mit der
bestehenden Hardware funktioniert.

### Platz 2 — Nachschärfen im Player-Shader (CAS)

**Wirkung: mittel. Aufwand: klein.**

Der Shader hat bereits einen Deband-Filter, der genau das Muster vormacht, das
CAS braucht (Nachbarn abtasten, gewichten). Die Andockstelle ist eindeutig:
`shader.wgsl` zwischen Zeile 301 (Deband) und 303 (Dither); im Uniform-Block
sind mit `u.output.w` und `u.hdr.w` zwei Felder frei, es bräuchte also keinen
größeren Umbau und keinen zweiten Renderpass.

FSR1/CAS ist unter MIT-Lizenz und herstellerneutral — passt zu unseren
Lizenzregeln, anders als libx264.

Ehrlich dazu: Schärfen holt **keine Information zurück**. Es macht die
Luma-Kanten knackiger und hilft bei grauem Text spürbar; die verschmierten
Farbkanten aus §5.4 repariert es nicht, es kann sie sogar betonen. Es ist die
billigste sichtbare Verbesserung, aber keine Antwort auf die Farbfrage.

### Platz 3 — Encoder-Abstimmung für Standbild/Text

**Wirkung: gering bis null für das eigentliche Problem. Aufwand: klein.**

Nach §5.1 ist hier fast nichts zu holen: bei 4 Mbit/s liegt das Luma schon bei
54 dB, und das Chroma hängt am Deckel der Unterabtastung, den keine
Quantisierungseinstellung anhebt. Adaptive Quantisierung, `stillimage`-Abstimmung
oder feinere QP-Steuerung verschieben Bits innerhalb des Lumas — dort, wo bereits
54 dB stehen.

Ein Detail ist trotzdem interessant: `vainfo` meldet für alle Encode-Profile
`VAConfigAttribEncROI: num_roi_regions=32, roi_rc_qp_delta_support=1`. Man könnte
also Bildbereiche gezielt feiner kodieren. Für Fernsteuerung wäre der naheliegende
Einsatz die Umgebung des Mauszeigers. Das ist eine eigene, spekulative
Untersuchung — und es hilft wiederum nur dem Luma.

### Nicht empfohlen: 4:4:4 selbst

Es scheitert auf unserer Hardware vollständig (§2.1), wäre andernfalls ein
NVIDIA-H.264-Sonderweg unter Aufgabe von AV1 (§2.2), verlangt einen neuen
SDP-Aufbau (§3.1), einen Playerumbau samt Verlust des Zero-Copy-Wegs (§4.2),
schadet bei schmaler Leitung (§5.3) — und hilft dem häufigsten Inhalt einer
Fernwartungssitzung, grauem Text, ohnehin kaum (§5.4).

---

## 7. Empfehlung

**4:4:4 nicht verfolgen.** Nicht, weil es unmöglich wäre, sondern weil es auf
unserer Hardware nicht existiert und auf fremder Hardware ein Sonderweg wäre,
der unseren Hauptcodec (AV1) und unseren schnellsten Zuschauerweg (Zero-Copy)
kostet — für einen Gewinn, der nur bei farbigem Text auftritt und nur oberhalb
von etwa 4 Mbit/s überhaupt positiv ist.

**Stattdessen, in dieser Reihenfolge:**

1. **Auflösungsumstellung am Host** als eigentliche Antwort auf „Text ist matschig".
   Sie greift die richtige Größe an (Luma-Auflösung), wirkt auf allen Plattformen,
   senkt die Bitrate und braucht keinen Eingriff in Encoder, Transport oder Player.
2. **CAS im Player-Shader** als billige, sofort sichtbare Ergänzung. Kleine,
   gut lokalisierte Änderung an einer Stelle, die dafür schon vorbereitet ist.
3. **Encoder-Abstimmung** nur, wenn nach 1 und 2 noch etwas fehlt — die Messung
   sagt, dass dort wenig liegt.

Für den Plan `2026-08-11-fernsteuerung-neubewertung.md` heißt das: 4:4:4 gehört
als **geprüft und verworfen** hinein, mit der Zahl aus §5.1 als Begründung, und
die Auflösungsumstellung gehört als eigener Arbeitspunkt aufgenommen.

---

## 8. Was gemessen wurde und was Recherche ist

**Gemessen auf dieser Maschine (AMD 780M, Mesa 26.1.5):**

| Was | Wie | Wo |
|---|---|---|
| VAAPI-Encode-Formate, alle Profile | `vainfo --display drm -a` | §2.1 |
| Encode-Versuch 4:4:4, drei Codecs | echter `ffmpeg`-Lauf, alle abgewiesen | §2.1 |
| VCN-Absturz bei `av1_vaapi` | beobachtet, `dmesg` | §2.1 |
| Reine Unterabtastung 4:2:0/4:2:2/4:4:4 | RGB→YUV→RGB, PSNR/SSIM gegen Original | §5.1 |
| Bitratenreihe 2–40 Mbit/s, `h264_vaapi` | 5 Läufe, PSNR je Ebene | §5.1 |
| Bitratenkosten von 4:4:4 | `libx264`, Standbild + bewegt, CRF und CBR | §5.2, §5.3 |
| Durchsatz `libx264` 4:2:0/4:4:4 | 1080p und 1440p, bewegter Inhalt, 16 Kerne | §2.5 |
| Grauer gegen farbiger Text | zwei Testbilder, reine Unterabtastung | §5.4 |
| Chromium WebRTC-Empfangsprofile | `RTCRtpReceiver.getCapabilities` headless | §4.1 |
| Chromium 4:4:4-Dekodierfähigkeit | `VideoDecoder.isConfigSupported`, 10 Kennungen | §4.1 |

Skripte und Bilder liegen neben dieser Datei im Scratchpad
(`mess_subsampling.sh`, `mess_encoder.sh`, `mess_x264.sh`,
`mess_planes_und_tempo.sh`, `mess_realistisch.sh`, `mess_gleiche_bitrate.sh`,
`mess_grau_gegen_bunt.sh`, `chromium_444.html`, `vergleich_zoom.png`).

**Codelage, gelesen und zitiert** (keine Messung, aber überprüfbar):
Sidecar-Pixelformate aller vier Plattformen, WHIP-SDP-Aufbau, webrtc-rs'
`register_default_codecs`, MediaMTX-Konfiguration und Fork-Patches,
`whep.ts`, Playerdecoder und -Shader.

**Reine Recherche, ausdrücklich ungeprüft:**
NVENC-, AMF-, QSV- und VideoToolbox-Fähigkeiten (§2.2, §2.4) — Herstellerangaben,
keine Hardware verfügbar. HEVC-Patentpools (§4.3) — allgemein bekannt, aber ohne
juristische Prüfung und ohne Position im Repo.

---

## 9. Was offen bleibt

**Wofür die Windows-/NVIDIA-Maschine nötig gewesen wäre:**

1. **Kann NVENC H.264 4:4:4 tatsächlich, und in welcher Qualität?** Das ist die
   einzige offene Tür zu 4:4:4 in Hardware. Prüfung wäre einfach:
   `ffmpeg -h encoder=h264_nvenc` auf Pixelformate (`yuv444p` gelistet?), dann ein
   echter Encode-Lauf mit dem Testbild aus dieser Untersuchung.
2. **Bestätigt sich, dass NVENC AV1 kein 4:4:4 kann?** Falls doch, ändert das die
   Bewertung deutlich, weil AV1 unser Hauptcodec ist.
3. **Kann AMF unter Windows mehr als VCN unter Mesa?** Meine Messung betrifft
   denselben Siliziumblock, aber einen anderen Treiber.
4. **Was bietet MediaMTX in der WHEP-Antwort an fmtp an?** Am laufenden Server
   nachzusehen; Quelle liegt nicht im Repo.
5. **Dekodiert Chromium einen echten 4:4:4-Strom flüssig?** Die Aushandlung ist
   gemessen, die Wiedergabe nicht — und sie liefe in Software.

**Unabhängig von 4:4:4 offen:**

6. **Der VCN-Absturz bei `av1_vaapi` auf Standbild-Eingabe** (§2.1). Ob das im
   echten Sidecar-Betrieb auftreten kann — etwa bei einem statischen Bildschirm
   während einer Fernsteuerungssitzung — ist ungeklärt und wäre das Nachsehen wert.
7. **Der Umschlagpunkt aus §5.3** ist an einem Inhalt und einem Encoder gemessen.
   Nach der Prüfstandsregel („ein Lauf je Variante trägt keine Entscheidung")
   wäre er vor einer Produktentscheidung zu wiederholen.
