# Regeln für das Windows-HQ-Labor

**Das Ziel:** Intra-Refresh-Streaming soll das reguläre Verfahren mit
periodischen Vollbildern **ersetzen** — das reguläre ist gebaut und läuft in
Produktion. Das Labor portiert Intra-Refresh auf diese Plattform.

Der Stand über die Plattformen:

| | |
|---|---|
| Linux, NVIDIA + AMD | vorangegangen, Referenz (`streaming/hq-labor/`) |
| **Windows, AMD** | **diese Maschine, hier wird gearbeitet** |
| Windows, NVIDIA | anderer Rechner, danach |

## Die vier Regeln

**1. Fortschritt ist nur, was auf dem Ziel liegt.**
Der Maßstab ist eine einzige Frage: läuft auf dieser Maschine ein Stream mit
Intra-Refresh? Encoder-Optionen, Sendeweg, Rückkanal, Messwerkzeuge sind
Zubringer — sie zählen, wenn sie diesem Ziel dienen, und nicht davon losgelöst.

**2. Jede Messung nennt den Encode-Weg und ob Intra-Refresh aktiv war.**
Eine Messung über `av1_amf` ist eine Messung am **alten** Verfahren. Sie darf
nie als Fortschritt am Ziel erscheinen — weder in einer Antwort noch in einer
Messakte. (Am 2026-08-02 zwei Tage lang genau so passiert.)

**3. Zubringer sind erst fertig, wenn sie angeschlossen sind.**
Ein gebauter, aber nicht verdrahteter Baustein ist nicht erledigt. Der
Vulkan-Import war Wochen „fertig", während die Pipeline weiter über AMF lief.

**4. Vor jedem Baustein: gegen die Linux-Seite abgleichen.**
Was dort gelöst ist, wird **portiert, nicht neu erfunden**. Abweichungen
brauchen einen benannten plattformbedingten Grund. Ohne diesen Abgleich baut
man an der Referenz vorbei — und merkt es spät.

## Was plattformübergreifend gilt (nicht neu herleiten)

* **Intra-Refresh ist eine Encoder-Option, keine Architektur.** Auf Linux läuft
  es über `av1_nvenc` mit `intra-refresh=1, forced-idr=1, g=600`.
* **Intra-Refresh heilt nach Verlust NICHT.** Ein einziges verworfenes Bild
  tötet den Strom dauerhaft — Hardware- wie Software-Decoder
  (`testbench/profiles/decoder-2026-07-29-intra-refresh.json`). Der Schutz
  kommt von FEC, NACK und **Vollbild auf Anforderung**. Deshalb ist der
  Rückkanal Voraussetzung, nicht Zubehör.
* **Der Nutzen ist belegt:** bei gleicher Bitrate ist Intra-Refresh besser als
  der heutige Weg (+0,4 VMAF, +2,3 dB PSNR, `allintra-2026-07-29.json`). Das
  muss keine Plattform neu zeigen.
* **Der WHIP-Sendeweg samt AV1-Paketierer** ist geteilt: `whip/mod.rs`,
  `whip/av1.rs` und `whip/pacer.rs` sind wortgleiche Kopien aus dem
  Linux-Labor, Abweichungen dort sind teuer. **`whip/av1_entpacken.rs` ist
  dagegen hier entstanden** — Linux hat keinen Entpacker, weil es dort keinen
  eigenen Zuschauer gibt. Nichts zurückzuportieren, aber auch nichts, was von
  dort käme.
* **OFFENER RÜCKPORT (2026-08-02):** `whip/av1.rs` ist seither **nicht mehr
  wortgleich**. Der Paketierer leitete „hier beginnt eine neue Bildfolge"
  daraus ab, dass ein Sequenzkopf im Zeitabschnitt steht — das stimmt nur,
  solange der Encoder ihn ausschließlich vor Vollbildern schreibt. `av1_amf`
  mit Auffrischung tut das nicht (6 Sequenzköpfe auf 1 Vollbild), und der
  Browser stolperte darüber. Berichtigt: `N` verlangt jetzt zusätzlich ein
  echtes Vollbild, und ein Sequenzkopf ohne Vollbild wird gar nicht erst
  gesendet. **Der Fehler steckt in der Linux-Fassung genauso** und ist dort nur
  nicht aufgefallen, weil NVENC sich wie `av1_vulkan` verhält. Herleitung:
  `amd-2026-08-02-qualitaet-und-browser.json`, Abschnitt 3.
  **Beim Rückport zwei Zeilen NICHT mitnehmen:** `lies_leb128` und
  `schreibe_leb128` tragen hier `pub(crate)`/`pub(super)`, weil Entpacker und
  Prüfwerkzeug sie brauchen — die gibt es auf der Linux-Seite nicht. Die Datei
  war also auch vorher nicht ganz wortgleich.
* **OFFENER RÜCKPORT (2026-08-04): der RTP-Zeitstempel.** Die ausgelieferte
  Fassung leitet ihn aus dem echten `pts` des Encoder-Pakets ab; dieses Labor
  rechnet ihn weiter ganzzahlig aus der **Bildzahl** (`whip::Av1Zustand`). Die
  Bibliothek liefert den `pts` seit dem 2026-08-04 mit (`PaketSenke::video`),
  `senke.rs` verwirft ihn hier bewusst — der Zähler ist genau das, was AV1
  gegen den abgeschnittenen 90-kHz-Zeitstempel immun gemacht hat.
  **Solange das Labor mit fester Bildrate und ohne Bild-Duplizierung misst,
  stimmen beide überein.** Unter Last nicht mehr: ein Zähler unterstellt, dass
  jedes eingeschobene Bild auch eines wird. Wer hier eine Messung mit
  Duplizierung fährt, holt den `pts` zuerst herein.
* **Und derselbe Fehlschluss steckt noch im Player** (`pulse-player`,
  `recorder.rs::scan_av1_for_sequence_header`): dort gilt ein Zeitabschnitt als
  Vollbild, sobald ein Sequenzkopf darin steht. Gegen unseren eigenen Sender ist
  das seit der Berichtigung zufällig richtig, gegen jeden anderen AV1-Sender
  nicht — und der Fehler wäre derselbe: der Player stiege auf einem
  Zwischenbild ein. Nicht angefasst, weil eigenes Programm; gehört auf die Liste.

## Was an DIESER Maschine anders ist

**10 Bit gibt es über den Vulkan-Encoder nicht** (gemessen 2026-08-02): ab dem
ersten Zwischenbild läuft die Farbebene auf Anschlag, das Bild wird magenta.
Das erste Vollbild ist einwandfrei, deshalb sieht jede Bildzählung gesund aus.
Der Fehler entsteht auch über FFmpegs eigenes `hwupload` ohne jeden D3D11-Bezug,
mit fester Quantisierung wie mit Ratensteuerung, mit wie ohne Intra-Refresh —
er liegt im Vulkan-Encode-Weg selbst, nicht bei uns. 8 Bit ist einwandfrei,
`av1_amf` kann 10 Bit auf derselben Karte. `vulkan_encoder::zehn_bit_pruefen`
bricht deshalb ab; `PULSE_LABOR_ZEHNBIT_TROTZDEM=1` hebt die Sperre auf, wenn
ein neuer Treiber zu prüfen ist. Herleitung: Messakte Abschnitt 11.

## Der Encode-Weg: seit 2026-08-02 AMF, nicht mehr Vulkan

**Ein nackter Lauf des Labors fährt jetzt den herstellereigenen Weg MIT
Auffrischung** — für AV1 setzt `auffrischung.rs` die Optionen selbst, bei H.264
bringt `usage=ultralowlatency` sie ohnehin mit. `PULSE_LABOR_VULKAN=1` holt den
alten Weg als Vergleichsarm zurück, `PULSE_LABOR_KEIN_IR=1` schaltet die
Auffrischung ab (beides nur zum Messen).

Warum umgestellt wurde, in einer Zeile: AMF ist an jedem gemessenen Punkt besser
(~43 % weniger Bits bei gleicher Qualität), 10 Bit ist dort farblich in Ordnung,
die Ratensteuerung funktioniert, und im Browser läuft alles in Hardware.

**Korrektur 2026-08-02: AMF kann doch Intra-Refresh.** Die Option heißt bei
`av1_amf` nicht `-intra_refresh`, sondern **`-intra_refresh_mode gop_aligned`**
(plus `-intra_refresh_stripes`). Damit ersetzt AMF die periodischen Vollbilder
tatsächlich — bei `-g 60` über 300 Bilder kommt **eines** statt fünf, die
Bitmenge bleibt gleich und verteilt sich statt in Stößen anzufallen. Das gilt
für 8 **und** 10 Bit, und das 10-Bit-Bild ist einwandfrei. `continuous` (Modus 2)
nimmt der Treiber an und tut nichts damit — das ist der Teil der alten Aussage,
der stimmt. Messung: `testbench/profiles/amf-2026-08-02-intra-refresh-doch.json`.

**Qualitativ ist AMF dem Vulkan-Weg deutlich überlegen** (2026-08-02, gleiche
verlustfreie Quelle, feste Quantisierung, Vergleich bei erreichter Bitrate):
rund **43 % weniger Bits bei gleicher oder besserer** PSNR/SSIM, an jedem
gemessenen Punkt. `av1_vulkan`s Ratensteuerung ist dabei nebenbei als unbrauchbar
aufgefallen — sie trifft ihr Ziel nicht und liefert bei gleicher Dateigröße
39,2 wie 47,8 dB. Messakte `amd-2026-08-02-qualitaet-und-browser.json`.

**Im Browser laufen alle drei Fälle** — AV1 8 Bit, AV1 10 Bit und H.264 —
mit Auffrischung durchgehend in Hardware, wiederholbar (je 3 Läufe einzeln und
einer mit allen dreien gleichzeitig, 0 Rückfälle). Dafür war eine Berichtigung
im **eigenen Sendeweg** nötig, nicht am Encoder: s. den offenen Rückport oben.
Der zunächst erratische Befund („mal Hardware, mal Software, mal kein Bild")
kam von dort.

**Am Zuschauer belegt** (Messstand, dekodierendes Messwerk): 1 Vollbild statt 6,
Einstieg ohne Anforderung bleibt schwarz wie bei Vulkan, Erholung nach Verlust
nur mit Anforderung (27,8 → 0,0 ohne, 28,0 → 29,5 mit), und AMF löst die
Anforderung während der Auffrischung ein. Offen bleibt allein die
Qualitätsmessung.

**Und bei H.264 läuft die Auffrischung längst — unbemerkt.** `usage=lowlatency`
und `ultralowlatency` bringen sie bei `h264_amf` von sich aus mit (5 Vollbilder
werden zu 1, verteilte Intra-Last statt Stöße), und `usage=ultralowlatency`
setzt der Sidecar seit dem 2026-07-30 aus Last-Gründen. Der Strom **heilt sich
danach nach Paketverlust ohne jede Anforderung** (28,5 → 28,9/s) — anders als
AV1 über denselben Messstand. Die eigentliche Option heißt dort
`-intra_refresh_mb <Makroblöcke>` und dreht nur noch am laufenden Zyklus.
Messakte `amd-2026-08-02-h264-intra-refresh.json`.

**Drei Encoder, drei Optionsnamen** (`av1_amf`: `intra_refresh_mode`+`stripes`,
`h264_amf`: `intra_refresh_mb`, `h264_d3d12va`: `intra_refresh_mode row_based`+
`duration`). Einen Namen vom Nachbarn zu übernehmen misst nichts — genau daher
kam der Fehlschluss.

**Seit dem 2026-08-04 hängt der Encoder NICHT mehr an der Senke.** Hier stand:
„über eine `http(s)://`-Push-URL erzwingt `encode_path` den D3D11-Weg
(`h264_amf`), eine Datei-Mitschrift desselben Auftrags läuft auf
`h264_d3d12va`; für vergleichbare Datei-Messungen `PULSE_HQ_AMD_D3D11=1`
setzen." Das ist überholt — **AMD geht jetzt mit jedem Codec über AMF**, und
damit encodiert eine Datei-Mitschrift genau wie ein Netz-Push.

Für den Messstand ist das eine echte Erleichterung: die Sichtprüfung an der
Datei und die Messung über die Leitung fahren endlich denselben Encoder. Der
Gegenprobe-Schalter heißt jetzt `PULSE_HQ_AMD_D3D12=1` und wirkt andersherum
(zurück auf `h264_d3d12va`); `PULSE_HQ_AMD_D3D11` gibt es nicht mehr.

D3D12 bleibt unbrauchbar. Der Vulkan-Encoder war lange der einzige belegte Weg
zum Ziel, und das erklärt die ganze Kette, die es sonst nirgends gibt:

1. `av1_vulkan` braucht ein FFmpeg mit `VK_KHR_video_encode_intra_refresh` →
   der Patch in `ffmpeg-patches/`.
2. Der Vulkan-Encoder braucht das Bild in Vulkan, ohne CPU-Umweg → `vkimport.rs`
   (D3D11-Textur über geteiltes NT-Handle).
3. Erst dann kann die Pipeline Intra-Refresh fahren.

**Hier stand „Das mitgelieferte FFmpeg hat die Option NICHT" — das gilt für den
Vulkan-Teil weiter, für AMF nicht mehr.** Seit dem 2026-08-04 baut der
ausgelieferte Sidecar sein FFmpeg selbst, mit
`streaming/ffmpeg-patches/0002-amfenc_av1-…` darin; `av1_amf` kennt
`intra_refresh_mode` dort also. Die Vulkan-Optionen bleiben Labor-Sache.

Der Rechner mit Windows+NVIDIA wird einfacher: NVENC hat `intra-refresh` wie
unter Linux.

## Der Ton (2026-08-02): unversehrt — aber H.264 läuft davon

Erstmals gemessen statt gezählt. Messakte
`../testbench/profiles/ton-2026-08-02-windows-messstand.json`, Werkzeug
`testbench/ton-referenz.ps1` + `testbench/ton-messung.ps1`, vier Läufe zu je
fünf Minuten über den Messstand.

**Unversehrt, ohne Einschränkung:** 239 721 Opus-Pakete, null verloren, null
Lücken beim Sender, null Millisekunden Stille, Piep-Takt 2000,0 ms, Stereo
bleibt Stereo. Die Stille-Auffüllung in `audio/wasapi.rs` hat nie eingegriffen.

**Aber der Bild-Zeitstempel von H.264 verliert je Bild einen Takt.** webrtc-rs
rechnet in `track_local_static_sample.rs:137` `(dauer_in_s * 90000) as u32` —
und `1.0/30.0 * 90000` ist 2999,9999999999995, was **abgeschnitten** wird.
Macht 1800 Takte je Minute = **20 ms**; gemessen −21,9 und −20,5 ms je Minute,
AV1 im selben Aufbau −0,5 und −0,0. Die Erklärung trifft die Stelle, nicht nur
die Größenordnung.

* **AV1 ist immun**, weil `Av1Zustand` den Zeitstempel ganzzahlig aus der
  Bildzahl neu rechnet — genau der Fall, gegen den der Kommentar dort steht.
* **Der ausgelieferte Sidecar ist nicht betroffen** (RTMPS über den
  ffmpeg-Muxer, verankerte Aufnahmezeit).
* **OFFENER RÜCKPORT:** `whip/mod.rs` ist auf der Linux-Seite dieselbe Datei —
  derselbe Fehler, dort ungemessen.
* **Behoben am 2026-08-03** (`dauer_fuer_takte()` in `whip/mod.rs`): die
  übergebene Dauer liegt jetzt eine **halbe** Takt-Breite höher, damit das
  Abschneiden auf dem gewollten Wert landet — für jede Bildrate, nicht nur für
  30. Drei Tests halten es fest, einer davon baut den alten Fehler nach.
  **Der Ton geht denselben Weg**, obwohl er die Falle heute nicht trifft:
  5 ms × 48000 fällt in f64 zufällig knapp *über* 240. Bei anderer Paketlänge
  liefe sonst der Ton weg statt des Bildes.
* **Gegenprobe:** +4,2 und −6,7 ms/min (vorher −21,9 und −20,5), je 149 Paare.
  Der einseitige Fehler ist weg; der Rest streut um null.
* **Vorsicht bei langen Läufen auf dieser Maschine:** nach rund einem Dutzend
  Fünf-Minuten-Läufen fällt der Bild-Decoder des **Empfängers** zurück (3859
  statt 8985 Bilder, entsprechend wenige Blitze), und die Drift-Steigung wird
  dadurch unsicher — ein 90-s-Lauf dekodiert wieder voll. Die **Ton**-Zahlen
  bleiben davon unberührt. Das Messwerk sollte den Decoder vor der Ernte
  leerlaufen lassen, statt stillschweigend weniger Bilder zu melden.

**Was die Zahl „Versatz bei Ankunft" (30–50 ms, Bild später) NICHT ist:** ein
Fehlerbeweis. Sie enthält Browser-Abspielweg, Aufnahme, Leitung und ±33 ms
Bild-Abtastung und gilt für einen Zuschauer **ohne** eigene Synchronisierung
(unser Player hat keine). Ein richtig synchronisierender Zuschauer ist nicht
vermessen.

**Und die Grenze des Werkzeugs:** es wertet den Ton aus, es hört ihn nicht.
Knacken, Verzerrung und Tonhöhenfehler fallen hier nicht auf.

## Bauen und Testen

**Aus dem Labor-Verzeichnis heraus bauen**, nicht mit `--manifest-path` von
anderswo: `FFMPEG_DIR` steht in `.cargo/config.toml`, und Cargo sucht diese
Datei vom **Arbeitsverzeichnis** aus. Von aussen aufgerufen findet
`ffmpeg-sys-next` nichts und verlangt `pkg-config`.

Das Labor linkt gegen `ffmpeg-patched/`. **Zur Laufzeit müssen dessen DLLs im
PATH stehen** — auch beim Testen:

```powershell
Set-Location …\streaming\win-hq-labor
$env:PATH = "$PWD\ffmpeg-patched\bin;$env:PATH"
cargo test
```

Ohne das startet kein Binary, und zwar **wortlos**: Windows bricht mit
`0xC0000135` (DLL nicht gefunden) ab, bevor eine Zeile Code läuft. `cargo test`
meldet dann nur „test failed" ohne Grund. Dazu gehören sieben
MSYS2-Laufzeit-DLLs (`libwinpthread-1`, `libgcc_s_seh-1`, `libstdc++-6`,
`libiconv-2`, `zlib1`, `libdav1d-7`, `libopus-0`) — die liegen bereits in
`ffmpeg-patched/bin`, weil der Bau sie sonst aus einer MSYS2-Installation
ziehen würde, die es auf einer anderen Maschine nicht gibt.

**Der PATH ist trotzdem nicht das, was wirklich entscheidet.** Windows sucht
DLLs **zuerst neben der `.exe`**, und `win-hq-sidecar/build.rs` legt sie genau
dorthin (`target/{profil}/` und `target/{profil}/examples/`). Wer
`ffmpeg-patched/` austauscht, bekommt deshalb **weiter den alten Bau**: das
Bauskript kopiert nur, wenn es läuft, und es läuft nur, wenn sich etwas
geändert hat, das es beobachtet. Am 2026-08-02 hat das eine halbe Stunde
gekostet — `ffmpeg -decoders` zeigte `libdav1d`, das Messwerk nahm trotzdem
`av1_amf`. Nach einem Austausch also die Kopie erzwingen:

```powershell
(Get-Item ..\win-hq-sidecar\build.rs).LastWriteTime = Get-Date
cargo build --release --bins --examples
```

**`--examples` baut das Binary NICHT mit.** Ein Lauf, der den Sender aus
`target/release/` startet, fährt dann eine alte Fassung — sichtbar nur daran,
dass eine gerade entfernte Log-Zeile noch erscheint. Immer `--bins --examples`.

**Schalter am Encode-Weg** (Standard ist seit 2026-08-02 AMF **mit**
Auffrischung — ein nackter Lauf braucht keinen davon):

| Variable | Wirkung |
|---|---|
| `PULSE_LABOR_VULKAN=1` | den alten Vulkan-Weg als Vergleichsarm |
| `PULSE_LABOR_KEIN_IR=1` | Auffrischung aus (Gegenprobe, gilt für beide Wege) |
| `PULSE_ENCODER_OPTS=…` | eigene Encoder-Optionen; sticht die Vorgabe |

`PULSE_LABOR_AMF` gibt es **nicht mehr** — AMF ist der Standard.

## Messen

**Die Prüfstrecke ist der Hetzner-Messstand**, nicht die lokale Schleife:
`https://pulse.unicutmedia.com/whep/<pfad>/whip?token=…` (Caddy prüft das
Token und setzt Basic-Auth für MediaMTX). Rund 59 ms Umlauf.

Der Server ist für genau diesen Zweck eingerichtet — beide Einstellungen sind
Absicht und dürfen nicht als Fehler „repariert" werden:

* **`PULSE_KEYFRAME_INTERVAL=0`** — der fest verdrahtete Zwei-Sekunden-Takt ist
  AUS. Sonst setzte er die Bild-Stöße zurück, gegen die Intra-Refresh antritt,
  und man misst den Takt statt der Sache.
* **`PULSE_FLEXFEC=1`, 10:2** — Vorwärtsfehlerkorrektur, weil Intra-Refresh
  sich nach Verlust nicht selbst heilt.

Lokal (`127.0.0.1`) ist nur für Werkzeug-Prüfungen gut: dort gibt es keinen
Verlust, keine Laufzeit, keine Schwankung — FEC und NACK treten gar nicht in
Erscheinung.

**Fallen im Messaufbau**, jede hat mindestens eine Stunde gekostet:
* **stdin offen halten.** Kommt die Anfrage aus einer Datei, sieht der Sidecar
  nach der letzten Zeile EOF und fährt korrekt herunter — mitten im
  Verbindungsaufbau. Von außen sieht das wie ein Netzproblem aus.
* **stderr am Ende in einem Stück lesen** (`ReadToEnd`). PowerShells
  `Register-ObjectEvent` hat Zeilen verschluckt, und zwar ausgerechnet die
  aussagekräftigen.
* **Die Uhr für die Erholung startet am ENDE des Verlust-Stoßes.** 60 Pakete
  sind bei 720p30 rund 660 ms, in denen naturgemäß nichts fertig werden kann;
  vom Anfang aus gemessen kamen 599 gegen 600 ms heraus und sahen nach „kein
  Unterschied" aus.
* **„Erstes Bild danach" ist kein Maß für Erholung.** Ein einzelnes Bild, das
  ohne die verlorenen Referenzen auskommt, setzt die Zahl auf 67 ms — auch wenn
  danach fast nichts mehr kommt. Die **Bildrate über das Fenster** trennt
  „läuft wieder" von „steht". Und `beschaedigt` hilft dabei nicht: dav1d gibt
  bei fehlenden Referenzen **kein falsches Bild** aus, sondern gar keines.

**„Es spielt" ist nicht „es spielt richtig".** Ein Browser, der ein Bild zeigt,
kann trotzdem auf der CPU dekodieren — weil sein Hardware-Decoder aufgegeben hat
und der Software-Rückfall einsprang. Das sieht man an keiner Bildzahl. Am
2026-08-02 lief AV1 8 Bit im Browser scheinbar tadellos und dekodierte in
Wahrheit durchgehend in Software; aufgefallen ist es erst, weil 10 Bit dabei
schwarz blieb (der Software-Decoder in Chromiums WebRTC kann kein 10 Bit).

Bei jeder Browser-Messung deshalb **im Protokoll nachsehen**, nicht nur zählen:

```
--enable-logging --log-file=… --v=1
```
* `Decoder implementation: … is_hardware_accelerated = true` — womit begonnen wurde
* `Decoder falling back to software decoding.` — **das ist die Zeile, auf die es ankommt**
* `Dav1dDecoder::Decode unhandled bit depth: 10` — Folge des Rückfalls, nicht Ursache

Die Ursache war ein zu kleines `seq_level_idx` von `av1_vulkan` (Level 3.0 bei
720p); berichtigt in `whip/av1_level.rs`. Die Lehre darüber hinaus: **eine
Fehlermeldung sagt, wer gescheitert ist, nicht warum die Kette dorthin kam.**
Ich habe daraus zuerst „Chromium kann kein 10 Bit" geschlossen — falsch, und die
Halbierung (AMF gegen Vulkan, mit und ohne Intra-Refresh) hätte das sofort
gezeigt.

**Ein Bild ansehen heißt: NICHT Bild 0.** Das erste Bild ist das Vollbild, und
es ist auch dann richtig, wenn alle folgenden es nicht sind — genau so lag der
10-Bit-Fehler zwei Tage lang verdeckt. Immer ein Bild aus der Mitte nehmen:

```
ffmpeg -f obu  -i <datei> -vf "select=eq(n\,45)" -vframes 1 -y bild.png   # AV1
ffmpeg -f h264 -i <datei> -vf "select=eq(n\,45)" -vframes 1 -y bild.png   # H.264
```

Der Dateimitschnitt dafür kostet nichts: eine `push_url`, die nicht mit `http`
beginnt, schreibt der Sendeweg als rohen Bitstrom in eine Datei (`senke.rs`).
Damit ist die Sichtprüfung ohne Netz und ohne Server zu haben.

**Und wenn das Bild falsch ist, zuerst das EINGANGSBILD ansehen**, bevor man den
Encoder verdächtigt: `PULSE_LABOR_BILDABZUG=<pfad.yuv>@<nummer>` holt genau
dieses Bild an der Übergabestelle zurück (`src/bildabzug.rs`; ohne `@` das
erste). Dieselbe Nummer wie oben nehmen — dann liegen Eingang und Ausgang
desselben Bildes nebeneinander, und die Frage „die Textur ist schon falsch" oder
„der Encoder liest sie falsch" ist in einem Schritt entschieden. Am 2026-08-02
hat genau dieser Abzug den Verdacht vom D3D11-Import genommen, der ihn zwei
Anläufe lang gebunden hatte. Die Zeile, die der Abzug ausgibt, enthält den
fertigen `ffmpeg`-Aufruf samt `-pix_fmt`.

**Ein Rückweg-Vergleich braucht eine Quelle, die sich unterscheidet.** Die
Vorgänger-Probe verglich die Chroma-Ebene gegen ein Feld, in dem überall
derselbe Wert stand — dagegen ist keine verschobene Ebene zu sehen, jeder
Versatz liefert wieder denselben Wert. Der daraus gezogene Ausschluss („der
Import ist es nicht") war deshalb nicht falsch, sondern wertlos, und hat trotzdem
zwei Anläufe gekostet.

**Und die wichtigste Messregel:** dem Log des Senders nicht glauben. Was am Bild
ankommt, wird an einer Quelle geprüft, die nicht der Sender ist — Datei plus
`ffprobe`, oder das dekodierende Messwerk (`src/whep.rs`). Am 2026-08-02 meldete
der Sender zwei eingelöste Vollbild-Anforderungen, in der Datei stand keine
einzige (`forced_idr` fehlte). Dasselbe am 2026-07-30 beim zerrissenen Bild, das
in jeder Kennzahl besser aussah als der gesunde Weg.

**Dem eigenen Messwerk auch nicht.** „0 Bilder dekodiert" hat am 2026-08-02
einen halben Tag lang nach einem Fehler im Strom ausgesehen und war einer im
Werkzeug: der gewählte Decoder hiess `av1_amf`, weil `libdav1d` im gelinkten
FFmpeg fehlte. Bei einem Nullergebnis deshalb **zuerst prüfen, womit gemessen
wurde** — das Messwerk schreibt den Decoder-Namen auf stderr.

## Niemals

* **Tokens/Stream-Keys ausgeben.** Auch nicht in Fehlermeldungen — dafür gibt es
  `pulse_win_hq_sidecar::redact::secrets`.
* **Das ausgelieferte Binary anfassen, um dem Labor zu helfen.** `win-build.yml`
  baut ausschließlich `win-hq-sidecar`; was dort landet, geht an Nutzer.
  Gemeinsames gehört als Baustein in die Bibliothek (s. `encode::senke`), nicht
  als Labor-Sonderfall.
