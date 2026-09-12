# Pulse-Player AMD-Prüfbericht — Stand 2026-09-12

Nur-lesendes Audit aller AMD-relevanten Codepfade im `streaming/pulse-player/`,
als Quelltextanalyse: die im Auftrag genannten Dateien wurden vollständig
gelesen (`decode.rs` 2858 Zeilen komplett, `probe.rs`,
`render/setup|mod|farbe|abdruck|fremdbild|fremdlinux.rs`,
`zerocopy/vaapi/{mod,anker,gestalt}.rs`, `zerocopy/{mod,linuxweg,uebergabe}.rs`,
`einfrieren.rs` samt `einfrieren/{abdruck,gpuabdruck}.rs`, `neuaufbau.rs`,
`stockung.rs`, `decoderwahl.rs`, `decodefaden.rs`, `main.rs`); von
`session.rs`, `app/mod.rs` die AMD-relevanten Abschnitte (hwdec-Patch
`session.rs:652-663`, Decoder-Start `session.rs:1014-1021` und
`bilder_ausgeben` `session.rs:1310-1420`, Renderer-Bau `app/mod.rs:592-745`,
Zeichenschleife `app/mod.rs:815-951`). **Jede kritische Annahme wurde gegen die
gebundene FFmpeg-Version verifiziert**: `ldd` zeigt
`libavcodec.so.62`/`libavutil.so.60` aus `~/.cache/pulse/ffmpeg/prefix` plus
System-`libva.so.2` und `libdav1d.so.7`; der Quellbaum liegt unter
`~/.cache/pulse/ffmpeg/src` und trägt **RELEASE 8.1.1** (Verifikationslücke:
keine). Wgpu-Seite gegen `wgpu-hal-30.0.0` aus der Cargo-Registry geprüft.
Anlass ist der Vorfall 2026-08-20 (dedizierte Radeon 16 GB, Linux/KDE,
Video-Ring-Kernel-Reset bei 1440p144 AV1 10 bit; 8 bit fehlerfrei).
Übersprungen mit Begründung: Audio (`audio*`),
Fernsteuerung/Tastensperre (`fernsteuerung/`, `tastensperre/`), FEC- und
Jitter-Innereien (`fec/`, `jitter.rs` — relevant ist nur die Lückenmeldung, die
über `depacket`/`session` verfolgt wurde), Overlay/Zeiger (`overlay/`,
`zeiger*`), Rekorder/Dump (`recorder.rs`, `dump.rs` — sitzen vor dem Decoder),
Windows-/CUDA-Wege (`zerocopy/bruecke.rs`, `platz.rs`, `warten.rs`,
`zerocopy/linux/`), `whep.rs` (Signaling/NACK; AMD-relevant ist nur die
Codec-Auswahl), `messen/` (teilt die geprüften Renderpfade).

Die Befunde H1 und M1 wurden zusätzlich unabhängig gegen Quelltext und
FFmpeg-Bau nachgeprüft (Ankerstellen zeilenweise bestätigt); die
Laufzeitbefunde dieser Maschine stehen in Abschnitt E.

## A. AMD-Pfad-Karte

| Stelle | Zweck |
|---|---|
| `decode.rs:527` (`ZUERST_NATIV_HW=false` auf Linux), `:534-594` (`candidates_mit`) | Kandidatenliste: `av1_cuvid` mit/ohne CUDA-Gerät schlägt sauber fehl ohne NVIDIA, gewinnt der **native Decoder `av1` mit VAAPI-hwaccel**; dahinter `av1_qsv`, `libdav1d`, `av1` |
| `decode.rs:717-719` (`hwdec_vorgabe`), `decoderwahl.rs:96-119` | `PULSE_PLAYER_HWDEC=0` als Notbremse; `PULSE_PLAYER_DECODER` als Messschalter (z. B. `av1+hw` erzwingt genau den VAAPI-Weg) |
| `decode.rs:725-728` (`vaapi_geraetepfad`), `:742-786` (`hw_geraet_anhaengen`) | `av_hwdevice_ctx_create(AV_HWDEVICE_TYPE_VAAPI, "/dev/dri/renderD128")`, Override `PULSE_PLAYER_VAAPI_DEVICE`, Gerät vor `avcodec_open2` an den Kontext |
| `decode.rs:1430-1449` (`try_open`) | `extra_hw_frames = zerocopy::zusatzbilder_vaapi()` vor dem Öffnen (wirksam nur mit wgpu-Gerät und eingeschaltetem VAAPI-Weg) — siehe Befund M1 |
| `decode.rs:1471-1609` (`decode`), `:1821-1863` (`on_gap`) | **Verlust-Verhalten**: Vorgabe NICHT leeren, weiter dekodieren, Anzeige über `unsauber_bis` sperren (`refresh_dauer`, `:421-428`, 2 s, `PULSE_PLAYER_REFRESH_MS` 100-10000); `PULSE_PLAYER_GAP_WAIT_KEYFRAME=1` stellt Flush+Warten wieder her |
| `decode.rs:1548-1569` | Nach abgelehntem Paket: Decoder flushen, `neuaufbau::classify` (ERROR_LIMIT=30, MAX_REBUILDS=2, `neuaufbau.rs:21,25,88-96`) → Rebuild immer **Software** (`:1722-1747`); `MAX_EINSTIEGE=3` (`:1637-1657`) |
| `decode.rs:1672-1705` (`auf_software`), `stockung.rs:86,94,111,139-153,175-177` | Bei Grafikstockung (≥300 ms, Wartezeit am Zaun/Rücklesen ≥ Hälfte): 3 Bündel in 60 s → EIN frischer Hardware-Anlauf (neues `av_hwdevice_ctx_create`+Decoder **vor** dem Wegwerfen des alten, `:1694-1701`), danach Software für die Sitzung |
| `decode.rs:2039-2138` (`drain`), `:2143-2229` (`convert`) | Ausgabe-Formate `YUV420P`/`YUV420P10LE`/`NV12`/`P010LE` (`:2149-2153`); `AUF_GPU_FORMATE` enthält `VAAPI` (`:198-203`); unbekannte Formate zählen gegen `MAX_UNBRAUCHBARE_BILDER=60` (`:300-323,1600-1607`) |
| `decode.rs:806-828` (`in_den_hauptspeicher`), `:842-882` (`PlanePool`, Deckel 8) | Rücklesepfad für Bilder, die die Brücke nicht nimmt (Deckel erreicht, VAAPI-Weg aus); Zielformat lässt FFmpeg wählen (NV12/P010) |
| `decode.rs:1068-1126` (`matrix_of`, `farbangaben_von`), `:1145-1190` (`spitze_nits_von`) | Farb-/Range-/Transfer-Signalisierung wird **aus dem Strom gelesen und befolgt**, nichts erzwungen; nur Diagnose-Overrides `PULSE_PLAYER_MATRIX/TRANSFER` |
| `zerocopy/mod.rs:170-182,211-233,249-344` | `bruecke_moeglich(VAAPI)` → `vaapi::erlaubt()`; `zusatzbilder_vaapi()`; `PULSE_PLAYER_ZEROCOPY=0` global, `abschalten()` prozessweit und unwiderruflich |
| `zerocopy/vaapi/mod.rs:65-108,134-177` | Brücken-Aufbau: verlangt `wgpu::Features::VULKAN_EXTERNAL_MEMORY_DMA_BUF`; Deckel 12 (`PULSE_PLAYER_ZEROCOPY_VAAPI_DECKEL`, 2-32); `Ok(None)` als Ventil bei vollem Deckel |
| `zerocopy/vaapi/anker.rs:96-126` (`abbilden`) | `av_hwframe_map(DRM_PRIME, AV_HWFRAME_MAP_READ)` — Surface bleibt Decoder-Surface, Anker hält den gemappten Frame |
| `zerocopy/vaapi/anker.rs:67-76,188-221` | Drop-Reihenfolge (Surface vor Platz), `F_DUPFD_CLOEXEC`-Duplikate der Layer-fds je Import |
| `zerocopy/vaapi/gestalt.rs:133-192` | Deskriptor-Prüfung: genau 2 Layer à 1 Plane, Formatpaar R8+GR88 (8 bit) bzw. R16+GR32 (10 bit), pitch/offset/Object-Index; Abweichung = Abweisung |
| `zerocopy/uebergabe.rs:45-84` | `Ok(None)` = Deckel (einmal Hauptspeicher), `Err` = Weg dauerhaft zu (`Some(None)`) |
| `render/fremdlinux.rs:186-244` (`dmabuf`) | `texture_from_dmabuf_fd(fd, modifier, pitch, offset)` — wgpu legt das VkImage mit `VK_IMAGE_TILING_DRM_FORMAT_MODIFIER_EXT` an; Versatz des Chroma-Objekts durchgereicht |
| `render/fremdbild.rs:184-211,215-263` | Merkmale (`VULKAN_EXTERNAL_MEMORY_DMA_BUF`, `TEXTURE_FORMAT_16BIT_NORM` für 10 bit); Import **je Bild** (VAAPI), Nachhut 3 (`:73,258-263`) |
| `render/setup.rs:31-36,109-122,185-196,312-349` | Oberflächenformat-Präferenz **Rgb10a2Unorm vor Rgba16Float**; Backend unter Linux „alles" → **Vulkan** auf AMD; `TEXTURE_FORMAT_16BIT_NORM` nur wenn angeboten, sonst 10→8-bit-Herunterrechnung |
| `render/farbe.rs:159-169,189-191,203-216,262-287` | Dither-Stufen 1024 für Rgb10a2; `scales`/`ebenenformate` koppeln Fourcc-Tabelle (`gestalt.rs`) und Shader-Skalierung |
| `render/mod.rs:393-405,434-437,496-513` | Abdruck im selben Kommandopuffer; Ringplatz-Freigabe erst nach GPU-Abschluss (`on_submitted_work_done`); `ohne_oberflaeche_melden` schützt vor Fehlabschaltung bei minimiertem Fenster |
| `render/abdruck.rs:68,235-341`, `einfrieren/gpuabdruck.rs:192-291` | Einfrier-Wacht auf dem Zero-Copy-Weg: Compute-Abdruck über die Luma der **importierten** Textur (kein Frontbuffer-Lesen), 3 Abholplätze, Reihenfolge erzwungen, Zulauf gibt bei 60 Bildern/5 s Stille den Weg auf |
| `session.rs:1014-1021`, `decodefaden.rs:56,129-144` | Decoder auf eigenem Thread mit wgpu-Gerät des Fensters; Schlangen-Deckel 300 Einheiten — Kommentar nennt explizit fehlende Bezugsbilder als wahrscheinlichen Auslöser des Grafikhängers (`:36-37`) |
| `app/mod.rs:592-593,701-703,847-865,931` | Renderer je Fenster, Gerät wandert in die Sitzung, `renderer.upload` → Fremdbild-Bindung |
| `main.rs:96-107` (`--decoder`) | Sonde: Decoder-Kandidaten ohne Strom abfragen (Erste-Diagnose auf fremder Maschine) |

## B. Befunde

### Hoch

**H1. Bewusster Verlustpfad füttert den VAAPI-hwaccel mit Bezugsbild-Lücken, ohne Flush und ohne jede Absicherung genau der Stelle, an der FFmpeg dem Treiber Referenzen unterjubelt** — `decode.rs:1821-1845` (Vorgabe-Zweig von `on_gap`: „Der Decoder wird dabei NICHT geleert"), `:1810-1817` (Begründung, gemessener libnvcuvid-Segfault ohne Sperre), FFmpeg-Seite `libavcodec/vaapi_av1.c:51-57` (`vaapi_av1_surface_id`), `:274-279` (`ref_frame_map[i] = ctx->ref_tab[i].valid ? … : vaapi_av1_surface_id(&s->ref[i])`), `libavcodec/vaapi_decode.h:30-33` (`ff_vaapi_get_surface_id` ist ein blindes `(uintptr_t)pic->data[3]`).
Belegt (Code): Nach einer Lücke baut der Zusammensetzer die nächste Einheit korrekt zusammen (`depacket/av1.rs:189-271` verwirft nur die angefangene Einheit), die darauf folgenden Differenzbilder sind syntaktisch vollständige Zugriffseinheiten mit **fehlenden Referenzen** und gehen bewusst weiter an den Decoder. `av1dec.c` verweigert sie nicht (`update_reference_list`, `av1dec.c:1202-1213`, prüft nur `refresh_frame_flags`); der hwaccel füllt `ref_frame_map` ohne Verfügbarkeitsprüfung. War ein Slot nie gefüllt, liefert `vaapi_av1_surface_id` zwar nominell `VA_INVALID_SURFACE` — aber `vaapi_av1_surface_id` testet nur `vf->f` auf Nicht-NULL, und ein einmal belegter, dann leerer Slot (`av1_frame_unref`/`ff_progress_frame_unref`, `av1dec.c:698-712`) hinterlässt ein nicht-NULL `AVFrame*` mit `data[3]==0` → `ff_vaapi_get_surface_id` liefert **VASurfaceID 0, eine reale Pool-Surface**. Der Treiber bekommt also valide klingende Referenz-Surfaces mit beliebig fremdem Inhalt (bzw. `VA_INVALID_SURFACE` in der engen Fensterlage), dekodiert ein Differenzbild darauf und schreibt das Ergebnis in eine P010-Surface — genau die Klasse „unvollständige/kaputte Access-Units an VCN", die der Auftrag als Verdachtsklasse benennt und die in der Vorfalls-Signatur (Ring-Reset, 10 bit) mündete. Spielerseitig gibt es dafür keinen AMD-spezifischen Wächter: `consecutive_errors` bleibt 0 (Pakete werden angenommen), der Einfrier-Wacht sieht bewegte „Müll"-Bilder.
Vermutet (nicht belegt): dass genau dieser Mechanismus den Kernel-Reset 2026-08-20 auslöste; die Messakte in `decode.rs:668-676` zeigt, dass auf 780M/iGPU mit aktuellem Unterbau Ring-Resets überlebbar sind, während der dedizierten-Karte-Fall offen ist.
Lösung (kleinster ehrlicher Diff zuerst): der Abschalt-/Messschalter **existiert bereits** — `PULSE_PLAYER_GAP_WAIT_KEYFRAME=1` (`decode.rs:1837,1848-1862`) leert den Decoder nach jeder Lücke und wartet aufs Vollbild. Erst auf der betroffenen Hardware messen (Arm D unten), danach entscheiden, ob der Vorgabe-Zweig je Vendor (VAAPI+10 bit) auf Flush umschaltet. Dazu der Lücken-Zähler `zustand.verworfen` (`session.rs:1363-1365`) um „Einheiten nach Lücke an HW-Decoder" erweitern, damit der Pfad überhaupt in den Statistiken sichtbar ist.

### Mittel

**M1. `extra_hw_frames` ist in der gebundenen FFmpeg wirkungslos — die Pool-Rechnung „Deckel + 4" trägt nur zur Hälfte** — Player: `zerocopy/vaapi/mod.rs:80-97` (`ABSTAND=4`, `zusatzbilder() = 12+4`), `decode.rs:1443-1448`; gebundene Quelle: `ffbuild/config.mak` → **`CONFIG_VAAPI_1=yes`**, `libavcodec/vaapi_decode.c:628-629` (dann `frames->initial_pool_size = 0`), `libavcodec/decode.c:1142-1146` (`extra_hw_frames` wird **nur bei `initial_pool_size > 0`** addiert), `libavutil/hwcontext.c:373-377` (Pool 0 → dynamischer `pool_internal`, `hwcontext_vaapi.c:663-666`).
Belegt: Der Surfaces-Pool wächst in diesem Build **dynamisch und ohne feste Obergrenze**; die Zusicherung der beiden Tests in `vaapi/mod.rs:250-260` („Pool ist größer als der Deckel") prüft nur die eigene Arithmetik, nicht das FFmpeg-Verhalten. Auswirkung (Vermutet): nicht Decoder-Hunger (den verhindert der dynamische Pool sogar besser), sondern fehlende VRAM-Schranke genau dort, wo das Design eine vorgesehen hat — auf einer 16-GB-Karte unsichtbar, auf der 780M (geteilter Speicher) potenziell relevant. Lösung: beim FFmpeg-Bump/`vaapi_decode.c`-Stand die Bedingung `decode.c:1142` nachsehen; oder die Pool-Größe selbst setzen (über `avcodec_get_hw_frames_parameters` den gelieferten `initial_pool_size` überschreiben) — kleiner Diff: erst Messung (Arm D.3), Kommentar mit dieser Verifikationslücke reicht fürs Erste.

**M2. Zwei-GPU-Fall (780M + dedizierte Radeon): kein Adapter-Abgleich, Fehlschlag erst beim ersten Bild und dann prozessweite Dauerabschaltung** — `zerocopy/vaapi/mod.rs:134-152` (prüft nur das Feature-Merkmal), `render/fremdlinux.rs:219-228` (Kommentar: „dafuer fehlt hier der UUID-Abgleich, den die CUDA-Bruecke hat"), `zerocopy/mod.rs:340-344` (`abschalten` prozessweit, nie wieder an), `decode.rs:1279-1290` (Gerät gehört je Fenster).
Belegt: VAAPI liegt fest auf `renderD128` (`decode.rs:725-728`), wgpu wählt den Adapter unabhängig (`setup.rs:206-215`, `HighPerformance` — prädestiniert für die dedizierte Karte); scheitert der DMA-BUF-Import über die PCIe-Grenze, fällt **ein** Bild unter den Tisch und der gesamte Weg geht prozessweit dauerhaft auf Rücklesen, auch für andere, sichtbare Sitzungen. Die CUDA-Brücke hat den UUID-Abgleich (`zerocopy/linux/kern.rs`), die AMD-Brücke bewusst nicht (Doku in `vaapi/mod.rs:25-31`). Auswirkung: Belegt ist der fehlende Abgleich und die Einmaligkeit der Abschaltung; vermutet ist der konkrete Fehlmodus (Import-Fehler vs. still langsam, Doku selbst). Lösung: im Fehlerpfad `render/fremdlinux.rs:219-228` die PCI-IDs von VAAPI-Gerät und wgpu-Adapter in die Meldung aufnehmen (ein eprintln) und — kleiner ehrlicher Schritt — `abschalten` je Sitzung statt prozessweit, sobald zwei-Fenster-Betrieb auf Hybrid-Maschinen gemeldet wird.

### Niedrig

**N1. Modifier wird auf Empfängerseite nie gegen `DRM_FORMAT_MOD_INVALID` geprüft (Spiegel von Sender-B5)** — `zerocopy/vaapi/gestalt.rs:133-192` (prüft Layer/Planes/Fourcc/pitch, **nicht** `objekte[i].modifier`), `zerocopy/vaapi/anker.rs:145-147` (Modifier wird roh übernommen), FFmpeg `libavutil/hwcontext_vaapi.c:1410-1411` (Modifier unverändert vom Treiber in den Deskriptor).
Auswirkung: Belegt ist die fehlende Prüfung; vermutet der Fehlmodus — würde Mesa `INVALID` exportieren, scheitert der Import erst in `wgpu-hal` (`vulkan/device.rs:568-581`: Modifier ungeprüft in `VkImageDrmFormatModifierExplicitCreateInfoEXT` → `DeviceError`) → `abschalten` mit generischer Ursache statt einer sauberen Meldung. Auf der 780M ist der Modifier real und gemessen bitgenau (`gestalt.rs:12-17`, Testkonstante `0x0200_0000_1040_1b04`). Lösung: drei Zeilen in `pruefen()` — `modifier == DRM_FORMAT_MOD_INVALID (0x00ff_ffff_ffff_ffff)` → `bail!` mit Modifier in der Meldung.

**N2. Der frische Hardware-Anlauf hält zwei Decoder und zwei VAAPI-Geräte kurzzeitig gleichzeitig offen** — `decode.rs:1694-1701` (`Self::new(self.codec, Some(true), …)` **bevor** `decoder_uebernehmen` den alten fallen lässt), `:1256-1262` (`hardware_anlaeufe`, genau einmal).
Auswirkung: Belegt ist die Doppelung (Neuaufbau-Kontext + alter Kontext auf derselben VCN-Einheit); vermutet, ob das den von `stockung.rs:96-111` dokumentierten Reset-Kaskaden-Zyklus verlängert — der Code dokumentiert die Gegenprobe: nach Kernel-Ring-Reset arbeitete ein frischer Kontext, die Kaskade wurde auf 60-s-Fenster/1-s-Bündel umkalibriert (`stockung.rs:90-111` mit dmesg-Beleg 2026-08-16). Rebuild nach Fehlerserie geht dagegen immer auf Software (`neuaufbau.rs` classify → `decode.rs:1722-1747`) — kein zweiter HW-Versuch, gut. Lösung: nichts im Code; einmal gezielt auf der Maschine messen (Arm D.4).

**N3. 10-bit-Import-Scheitern schaltet den Weg prozessweit ab statt nur die 10-bit-Sitzung** — `render/fremdbild.rs:196-211` (`moeglich` prüft `TEXTURE_FORMAT_16BIT_NORM` je Bild), `:215-245` (`binden` → `None`) → `render/mod.rs:259-261` (`abschalten("der Renderer kann die Textur nicht einhaengen")`), `zerocopy/mod.rs:340-344`.
Auswirkung: Auf einem Gerät ohne das 16-bit-Merkmal läuft 8 bit Zero-Copy, das erste 10-bit-Bild beendet den Weg für **alle** Sitzungen und Fenster, dauerhaft. Belegt ist die Kette, vermutet die Praktikabilität (Geräte mit DMA-BUF, aber ohne `TEXTURE_FORMAT_16BIT_NORM` sind selten; auf RDNA1+ vorhanden). Lösung: `moeglich()` vorher in `zerocopy::bruecke_moeglich` berücksichtigen — eine Bedingung mehr in `vaapi::erlaubt()`-Nähe, nicht mehr Zeilen als die Meldung.

## C. Explizit geprüft und ok

- **10-bit-hwaccel-Wahl**: Unter Linux gibt es genau einen Hardware-Weg für AV1 — der native Decoder mit `AV_HWDEVICE_TYPE_VAAPI` (`decode.rs:93-108,224-232`); kein Vulkan-hwaccel in der Liste. FFmpeg-Seite: `vaapi_av1.c:59-73` leitet die Bittiefe korrekt aus `seq_profile`/`high_bitdepth`/`twelve_bit` her; `vaapi_decode.c:325-390` wählt `sw_format` per `av_find_best_pix_fmt_of_2` gegen das Quellformat, Tabelle enthält `P010→P010` und `I010→YUV420P10` (`:282-295`) — beide Ausgabeforemate deckt `convert` ab (`decode.rs:2152-2153`), der Planar-Fall inklusive Bitlagen-Korrektur (`render/farbe.rs:203-216`, `probe.rs:296-318`). Software-Fallback `libdav1d` liefert `YUV420P10LE` (`libavcodec/libdav1d.c:61`) — ebenfalls abgedeckt.
- **Farbsignalisierung**: Der Player erzwingt nichts — Range, Matrix, Transfer, Primaries und MaxCLL/Mastering werden aus dem Strom gelesen und befolgt (`decode.rs:1068-1190,2224`), Overrides nur als Diagnose. Auf dem Zero-Copy-Weg liest `uebergabe.rs:110-111` dieselben Felder vom Original-Frame.
- **Zero-Copy-Korrektheit (AMD)**: Gestalt „1 Objekt, 2 Layer, je 1 Plane" wird strikt erzwungen (`gestalt.rs:137-159`, Tests gegen 2-Plane-Layer, NV12-Einzellayer, gemischte Paare `:241-271`); Fourcc-Tabelle gegen `render::farbe::ebenenformate` getestet (`:287-297`); der gesamte Weg ist auf der 780M für H.264/AV1 8 und 10 bit **byteweise bitgenau gemessen** (Messakte in `vaapi/mod.rs:17-23` und `fremdlinux.rs:180-181`).
- **Synchronisation Decoder→Import**: Die Behauptung in `anker.rs:89-95` („`AV_HWFRAME_MAP_READ` setzt `VA_EXPORT_SURFACE_READ_ONLY` und löst `vaSyncSurface` aus") ist in der gebundenen Quelle verifiziert: `hwcontext_vaapi.c:1374-1381` (`vaSyncSurface` im READ-Zweig), `:1388-1390` (`vaExportSurfaceHandle(DRM_PRIME_2, READ_ONLY|SEPARATE_LAYERS)`); `ff_hwframe_map_create` hält die Quelle per `av_frame_ref` (`hwcontext.c:741-790`) — der Anker-Ansatz (gemappten Frame halten) ist genau richtig.
- **Lebensdauer/Surface-Kollision**: Anker hält die Surface bis nach dem letzten Zeichendurchgang — Deckel 12 (`vaapi/mod.rs:65-71`), Nachhut 3 (`fremdbild.rs:73,258-263`), Freigabe erst nach GPU-Abschluss (`render/mod.rs:512-513`), Drop-Reihenfolge „erst Surface, dann Platz" (`anker.rs:67-76`), Fehlerpfad gibt den Platz sofort zurück (`vaapi/mod.rs:169-175`). `import_je_bild` trennt die Aufbewahrungsregeln beider Linux-Brücken (`linuxweg.rs:148-150`).
- **fd-Hygiene**: Duplikate mit `F_DUPFD_CLOEXEC` (`anker.rs:209-221`); wgpu-hal übernimmt den fd und schließt ihn bei Fehlschlag selbst (`wgpu-hal-30.0.0/src/vulkan/device.rs:522-524,595-601` — mit dem Sicherheitsauflagen-Text im Quelltext verifiziert); die Original-fds schließt FFmpegs Unmap (`hwcontext_vaapi.c:1339-1346`); kein doppeltes `close` an einer Stelle.
- **wgpu-Import-Semantik**: `UNINITIALIZED` als Layout-Zustand beim DMA-BUF-Import ist für den Vulkan-Weg korrekt und auf der Karte gemessen (Inhalt wird nicht verworfen, `fremdlinux.rs:230-244`); Abdruck und Musterprobe hängen an derselben Bedingung (`render/mod.rs:425-444`), Abholung erst nach `submit` (`:496-501`, `abdruck.rs:288-302`).
- **Robustheits-Wächter**: ERROR_LIMIT=30/MAX_REBUILDS=2 mit Bewährung (`neuaufbau.rs:21-96`), MAX_EINSTIEGE=3 mit Einstiegspunkt-Unterscheidung (`decode.rs:1637-1657`), Stockungs-Bündelung 3-in-60 s gegen die dmesg-belegte Reset-Kaskade (`stockung.rs:86-111,240-255`), `MAX_UNBRAUCHBARE_BILDER=60` gegen das unsichtbare 4:4:4-Standbild (`decode.rs:300-323`), Decoder-Thread-Isolation (`decodefaden.rs:1-37`), hwdec-Wächter auf Prozessebene dokumentiert (`decode.rs:659-666`).
- **10-bit-Renderpfad**: Rgb10a2Unorm als Ausgabe-Präferenz, Dither mit 1024 Stufen, `wide`-Textur nur mit bestätigtem Merkmal, sonst korrektes Herunterrechnen (`setup.rs:31-36,318-329`, `farbe.rs:159-169,203-216,277-287`) — alles testgetragen.
- **Kein Frontbuffer-Konflikt**: Der Einfrier-Abdruck liest die Luma der importierten Textur per Compute-Pass, nicht den Frontbuffer; die Musterprobe kopiert vier Zeilen nur bei laufender Sonde (`render/fremdbild.rs:85-99`, `musterprobe`-Verweise). Das Dekodieren schreibt in Surfaces, die der Renderer nie gleichzeitig liest (Anker-Kette oben).

## D. Offene Fragen (nur mit AMD-Laufzeit zu klären)

1. **Vorfallpfad H1 auf DIESER Maschine nachstellen**: 780M bzw. die dedizierte Radeon, 1440p144 AV1 10 bit vom eigenen Sender, künstlicher Bündelverlust ~5 % (`testbench`-Verlustprofil), je drei 10-Minuten-Läufe in vier Armen: (a) Vorgabe, (b) `PULSE_PLAYER_GAP_WAIT_KEYFRAME=1`, (c) `PULSE_PLAYER_HWDEC=0`, (d) `PULSE_PLAYER_ZEROCOPY_VAAPI=0`. Messen: `journalctl -k --since "-15min" | grep -iE 'amdgpu|ring|vcn|reset'` (Signatur `ring vcn_unified_0 timeout … reset succeeded` bzw. device-wedged), dazu `PULSE_PLAYER_ERHOLUNG_LOG=1` und die Player-stderr-Zeilen (Vollbild-Abstand, Stockungen). Entscheidend: verschwindet die Reset-Signatur in Arm (b)?
2. **Welcher Decoder ist tatsächlich aktiv**: `pulse-player --decoder` auf der Maschine (erwartet auf AMD: `av1_cuvid` zweimal „geht nicht", `av1` (Hardware VAAPI) „geht") — das bestätigt die Kandidaten-Kette von A im Betrieb.
3. **Pool-Wachstum zu M1**: Läuft der Weg mit Deckel-Churn (Fenster verkleinern/verdecken, um `Ok(None)`-Ventile zu provozieren), VRAM-Belegung verfolgen (`radeontop`, `sudo cat /sys/class/drm/card*/device/mem_info_vram_used`); wächst der VAAPI-Pool über die rechnerischen ~33 Surfaces hinaus, ist `extra_hw_frames`-Wirkungslosigkeit (M1) live belegt.
4. **Frischer Hardware-Anlauf zu N2**: Stockungs-Arme absichtlich erzeugen (`PULSE_PLAYER_STOCKUNGS_RUECKFALL=0` zur Beobachtung, dann ohne), zählen `ring … reset`-Meldungen pro Zwischenfall mit und ohne anschließenden Neustart-Kontext; Vergleich der Kaskadenlänge.
5. **Modifier sichtbar machen**: `LIBVA_TRACE=/tmp/va.trace` beim 10-bit-Lauf — der Trace zeigt `vaExportSurfaceHandle` samt Modifier/Fourcc der Ebenen; gegen die erwartete Gestalt (R16/GR32, Modifier Top-Byte 0x02 für AMD) prüfen und N1 quantifizieren, ob `INVALID` auf irgendeinem Treiberstand vorkommt.
6. **Hybrid-Maschine zu M2**: 780M als Render-GPU + dedizierte Radeon, `PULSE_PLAYER_VAAPI_DEVICE` auf die jeweils „falsche" Karte zeigen lassen — Import-Fehlermeldung einlesen, Fallback auf Rücklesen bestätigen, Verhalten des zweiten Fensters während `abschalten` beobachten.

---

**Historie als Kontext**: Kein Commit im Player reagiert auf den Vorfall 2026-08-20 (git log `--since=2026-08-19 --until=2026-09-01 -- streaming/pulse-player/`: nur Ablage-/Fernsteuerungs-Arbeit). Die AMD-Unterbau-Commits sind älter: `60c596d7` (2026-08-10, VAAPI-Zero-Copy-Brücke), `5a11f5a9`/`00b8bb63` (GPU-Reset-Überlebbarkeit, dokumentiert), `79cfc1ca`/`4ac80b3a` (Treiberzwischenfall/Beschädigter-Bitstrom-Entscheidung); `decode.rs` wurde zuletzt im Umfeld des Intra-Refresh-Entfalls (2026-08-21) angefasst. Der Versuch, auf System-FFmpeg zu wechseln (`0dea3133`, 2026-09-07), wurde noch am selben Tag reverted (`a7fcaca2`) — der private Bau 8.1.1 ist lasttragend, weshalb die Verifikation gegen `~/.cache/pulse/ffmpeg/src` (8.1.1, identisch zur gelinkten `libavcodec.so.62`) die richtige Referenz war.

## E. Laufzeitbefunde auf dieser Maschine (2026-09-12, dieselbe Sitzung wie das Audit)

Maschine: AMD Radeon 780M (Phoenix, RDNA3/GFX11, iGPU), amdgpu, Mesa 26.2.2,
Kernel 7.2.3 (CachyOS), Wayland/Hyprland. Der Vorfalls-Rechner war eine
dedizierte Radeon 16 GB — diese Maschine ist also die iGPU-Ecke der Frage.

- **VAAPI-Profile** (`vainfo --display drm`): AV1 Profile 0 (VLD **und** EncSlice),
  HEVC Main/Main10, VP9 Profile 0/2, H264 — die 10-bit-Dekodierung ist
  grundsätzlich vorhanden.
- **Kernel-Log vor den Tests sauber**: keine Video-Ring-Resets in der
  Historie; einzig zwei harmlose Display-Core-REG_WAIT-Timeouts beim
  Monitor-Handshake (`optc314_disable_crtc`, `dcn31_program_compbuf_size`).
- **Linkage**: Player bindet private FFmpeg 8.1.1 (`.so.62`, RPATH
  `~/.cache/pulse/ffmpeg/prefix`) + System-`libva`/`libva-drm`/`libdrm` +
  System-`libdav1d.so.7` — exakt die auditierte Konstellation.
- **Basis-Lauf, ungestört** (`testbench/harness.py`, Vorlage frisch auf dieser
  Maschine mit `av1_vaapi` erzeugt: 10-bit AV1 2560×1440@144, CBR 25 Mbit/s,
  2-s-GOP, 4320 Bilder = 4320 Zugriffseinheiten, 15 Vollbilder — keine
  Alt-Ref-Versteckbilder): **Hardware-Dekodierung 140,3 fps mittel** (Soll
  144; Tiefpunkt 53 im Aufbau), null Fehler im Player-Log, **null
  GPU-Resets** vorher/nachher. Der Vorfall reproduziert sich mit sauberem
  Strom nicht — erwartet, denn H1 lebt vom Verlustpfad.
- **Gegenprobe Software-Dekoder** (`--hwdec sw`, `libdav1d`): **71,2 fps
  mittel** bei demselben Profil — der Rückfall trägt 1440p144 10 bit nicht.
  VAAPI-Hardware ist auf diesem Profil zwingend; scheitert sie, halbiert
  sich die Bildrate.
- **Nicht gefahren**: der Verlust-Arm (D.1) — er kann VCN so belasten, dass
  im Worst-Case die Grafiksitzung mitreisst, und braucht ein explizites Go.

## F. Verlust-Matrix (D.1 ausgeführt, 2026-09-12 Abend — mit Go des Nutzers)

Aufbau wie D.1: `testbench/netz-harness.py --profil buendel_fern --nur-empfang`
(Gilbert-Elliott-Bündelverlust 2 %/40 %/100 %/0 % plus 26,7 ms Laufzeit, nur
der Weg MediaMTX→Player), Vorlage aus Abschnitt E (10-bit AV1 2560×1440@144,
CBR 25 Mbit/s, 2-s-GOP), je Arm zwei Durchgänge à 360 s. Reset-Signatur:
`journalctl -k` auf `vcn_unified_0 timeout/reset`, Zählung vor/nach jedem
Lauf. Protokolle: `testbench/h1-*-samples.json`, `h1-*-player.log`,
`/tmp/h1-matrix.log`.

| Arm | Durchgang | Verlustwirkung | Ergebnis | vcn-Resets |
|---|---|---|---|---|
| (a) Vorgabe | 1 | 41.338 Pakete, 5,11 % | **Player-Prozess gestorben** („stdout geschlossen") nach ~20 s | **0 → 8** (2 Ereignisse) |
| (b) Flush | 1 | 988.347 Pakete, 5,02 % | 144,0 fps, 0 Stillstände, „ok" | 8 → 8 |
| (c) Software | 1 | 15.798 Pakete, 4,96 % | **Sitzung tot nach 6,7 s** („Decoder kommt nicht mehr nach — Rückstand zu gross") | 8 → 8 |
| (d) Zero-Copy aus | 1 | 16.202 Pakete, 5,44 % | 89 fps, Rücklesepfad zu langsam | 8 → 8 |
| (a) Vorgabe | 2 | 603.619 Pakete, 4,95 % | Prüfstand meldet „ok" — **darunter 6 vcn-Resets**, Stockungen 2,0–2,7 s je 1 Bild an der Zero-Copy-Brücke, fps am Laufende 9 | **8 → 20** |
| (b) Flush | 2 | 988.710 Pakete, 5,01 % | 144,0 fps, 0 Stillstände, „ok" | 20 → 20 |
| (c) Software | 2 | 19.994 Pakete, 4,41 % | 100 fps, schwach (Rückfall trägt nicht) | 20 → 20 |
| (d) Zero-Copy aus | 2 | 11.191 Pakete, 4,40 % | 56,5 fps, schwach | 20 → 20 |

**Befunde:**

1. **H1 ist live bestätigt.** Der Vorgabe-Weg erzeugte in BEIDEN Durchgängen
   die Vorfalls-Signatur (`ring vcn_unified_0 timeout → reset succeeded`,
   „device wedged, but no recovery needed") — im ersten Durchgang nach ~20 s
   mit Player-Tod, im zweiten sechs Reset-Ereignisse über 6 Minuten verteilt.
   Der Flush-Arm (b) nahm die **größte** Exposition des ganzen Laufs (989.000
   Pakete je Durchgang, 5 % verworfen) und blieb in beiden Durchgängen ohne
   jeden Kernel-Vorfall bei voller Bildrate.
2. **Der Prüfstand hat die Schäden in (a)-2 und (c)-1 zunächst „ok" gemeldet**
   — genau die Fehlerart aus WISSENSSTAND §6.4 (Lebendkontrolle mit Lücke):
   in (a)-2 lief der Ring sechsmal in den Reset, die Sekundenzeilen sahen
   gesund aus, erst die Player-stderr-Stockungszeilen und dmesg zeigten die
   Wahrheit; der Zustand „playing" täuschte, die letzte Probe lag bei 9 fps.
   Für AMD-Prüfläufe gehört die dmesg-Signatur in die automatische Auswertung,
   nicht nur die Player-Statistik.
3. **Die Software-Arme bestätigen Abschnitt E**: `libdav1d` trägt 1440p144
   10 bit nicht (Sitzungstod an Rückstand nach 6,7 s; 86–100 fps, wenn er
   durchhält). Die Arme (c)/(d) sahen deshalb nur ~1–2 % der Paketexposition
   von (a)/(b) — als Kontrollen für die Reset-Frage sind sie schwach, als
   Tragfähigkeitsnachweis des Rückfalls aber eindeutig: ohne VAAPI-Hardware
   ist das Profil auf dieser Klasse Hardware nicht bedienbar.
4. **Kernel-Einordnung**: Auf der 780M (iGPU) fängt der Kernel jeden Reset
   („reset succeeded", „no recovery needed") — der Desktop blieb unversehrt,
   der Player starb nur im ersten Vorgabe-Durchgang. Ob die dedizierte
   Vorfallskarte (16 GB, Radeon) denselben containeden Reset zeigt, ist
   weiterhin offen (D.1 zweiter Rechner).

**Konsequenz (lösungsnah)**: Der Schalter `PULSE_PLAYER_GAP_WAIT_KEYFRAME=1`
ist auf AMD/VAAPI die richtige Vorgabe — mindestens für AV1+10 bit, wo das
Profil ohnehin nur mit Hardware-Dekodierung läuft (Abschnitt E). Die
Umschaltung je Vendor (VAAPI → Flush, NVIDIA → unverändert, dort stammt die
0-fps-Messung gegen den Flush vom 2026-07-28 aus der Zeit vor dem heutigen
Code) ist der kleinste ehrliche Diff; die Messung hier nimmt H1s
Lösungsvorschlag aus Abschnitt B vollständig an. Offen bleibt der NVIDIA-Gegenbeweis
auf aktuellerem Stand (der gemessene Segfault von 2026-07-28 betraf
`libnvcuvid`, nicht VAAPI).

**Umgesetzt am selben Abend** (`decode.rs`): Der Decoder merkt sich seinen
hwaccel (`VideoDecoder::hw`), und `flush_bei_luecke` entscheidet je Geraet —
VAAPI leert als Vorgabe, alles andere nicht; `PULSE_PLAYER_GAP_WAIT_KEYFRAME`
wirkt jetzt in beide Richtungen (`1` erzwingt Leeren, `0` erzwingt
Weiterdekodieren, ungesetzt = Vorgabe). Prüflogik: drei Tests gegen die
reine Entscheidungsfunktion (Suite: 528 bestanden). Verifikation gegen den
neuen Stand: 180 s derselbe Bündelverlust (493.000 Pakete, 5,03 % verworfen)
OHNE Schalter — **0 neue Resets**, 144,0 fps, 0 Stillstände, Player lebt;
zum Vergleich der Vorgabe-Arm vor dem Fix: 2 Resets und Player-Tod nach
~20 s unter identischer Störung.
