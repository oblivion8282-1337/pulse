# AMD/VAAPI-Prüfbericht Sidecar — Stand 2026-09-12

Nur-lesendes Audit aller AMD-relevanten Codepfade im
`streaming/linux-hq-sidecar/`, ausgeführt als gründliche Quelltextanalyse
(jede relevante Datei vollständig gelesen; kritische Annahmen zusätzlich
gegen den gebundenen FFmpeg-8.1-Quelltext verifiziert). Anlass: der
Vorfall 2026-08-20 (Zuschauer, Linux/KDE, dedizierte Radeon 16 GB VRAM:
Video-Ring-Kernel-Reset bei 1440p144 AV1 10 bit; 8 bit lief fehlerfrei)
und der Wunsch, weitere Schwachstellen im AMD-Weg zu finden.

Nachtrag-Abend 2026-09-12: Der Vorfalls-Rechner war eine **dedizierte
Radeon mit 16 GB VRAM** — kein iGPU-/Kapazitätsfall. Das Fehlerbild
(Video-Ring-Kernel-Reset) ist die Signatur eines Dekoder-Bugs im
10-bit-Pfad des Empfängers, nicht einer Überlastung.

## A. AMD-Pfad-Karte

| Stelle | Zweck |
|---|---|
| `src/system/drm.rs:45-52` | Treiber→Vendor: `amdgpu`→Amd (VAAPI-Familie) |
| `src/system/drm.rs:128-159` | `detect()`: dGPU vor iGPU, `PULSE_HQ_VENDOR`-Override |
| `src/system/drm.rs:165-192` | `render_nodes()`/`present_vendors()`: pro-Karte-Kandidaten für den Import-Fallback |
| `src/system/drm.rs:204-211` | `vendor_from_modifier()`: Buffer-Besitzer aus Modifier-Top-Byte (AMD=2) |
| `src/capture/egl_modifiers.rs:51-86` | Modifier-Union aller EGL-Devices + **AMD-DCC-Filter** (`vcn_incompatible_dcc`, Zeile 94-101: Vendor 0x02, DCC-Bit 13, Tile-Ver < GFX12) |
| `src/capture/egl_modifiers.rs:183-195` | external_only-Modifier werden nicht angeboten (nicht GL_TEXTURE_2D-bindbar) |
| `src/capture/pipewire_stream.rs:293-306` | Fourcc-Map: BGRx→XRGB8888, BGRA→ARGB8888, 210LE→XBGR/ABGR2101010 |
| `src/capture/pipewire_stream.rs:355-410` | EnumFormat-POD: Modifier-Choice (MANDATORY\|DONT_FIXATE), fps als Preferred |
| `src/capture/pipewire_stream.rs:437-463, 594-730` | DONT_FIXATE-Fixierungstanz, Loop-Guard, Epoche/`buffer_key` |
| `src/capture/portal.rs` (gesamt) | ScreenCast-Verhandlung, Restore-Token, Cancel, Session-Close-Guard |
| `src/stream_controller.rs:605-630` | Kandidatenliste: Modifier-Hinweis → detect-Default → present_vendors |
| `src/stream_controller.rs:632-681` | `build_importer`: AMD/Intel-Zweig baut `VaapiImporter` mit **Wunsch-**`params.ten_bit` |
| `src/stream_controller.rs:685-724` | Kandidatenloop: Import des ersten Frames entscheidet die Karte; `OwnedFrame` |
| `src/stream_controller.rs:741-793` | `codec_fuer_aufloesung`, ten_bit↔Codec-Kopplung, **lastgrenze** |
| `src/encode/va_import.rs` (gesamt) | DMABUF→DRM_PRIME→`hwmap derive_device=vaapi`→`scale_vaapi format=nv12\|p010:bt709:limited`→buffersink |
| `src/encode/va_import.rs:271-290, 294-323` | Graph-Rebuild bei Größen-/Fourcc-Wechsel, Ausgabe fix |
| `src/encode/hw.rs:23-28, 76-128` | `HwContext` (VAAPI-Device) für die **Probe**; Live-Pfad nutzt ihn nicht |
| `src/encode/opts.rs:17-25` | `encoder_name`: AMD/Intel → `h264_vaapi`/`av1_vaapi` |
| `src/encode/opts.rs:206-280` | AMD-Zweig: `rc_mode=CBR`, `async_depth=1`; `low_power`/`compression_level`/`tiles` bewusst weg (Messakten im Kommentar) |
| `src/encode/opts.rs:312-324` | `warn_unknown`: fängt stille av_dict-Verwerfungen (Quelle: `PULSE_ENCODER_OPTS`) |
| `src/encode/mod.rs:570-666` | `open_encoder`: hw_frames_ctx-Bindung, Farbsignalisierung für VAAPI jeder Bittiefe, GOP, bf=0 |
| `src/encode/mod.rs:937-1045` | `probe_encoder(_at)`: VAAPI-Probe NV12/P010LE am Render-Node |
| `src/lastgrenze.rs:40-58` | 300-Mpix/s-Deckel nur für 10 bit, FPS-Stufenleiter |
| `src/caps.rs:87-129, 163-208` | Probe 720p + Auflösungsprobe (>4096×2304), Cache/Retry-Logik |
| `src/whip/mod.rs`, `src/whip/av1.rs` (→ `streaming/pulse-whip/src/av1.rs`) | AV1-RTP-Paketierer: Fuell-/Zeittrenner-/Kachellisten-Filter (av1.rs:184), Sequenzkopf nur am echten Vollbild (267-270), pts-Identität (422-432) |

Unterschied Nvidia↔AMD im Ganzen: Importer (EGL/CUDA-Interop + GL-Blit vs.
FFmpeg-Filtergraph), Frames-Kontext (CUDA-Pool BGR0/RGB0/P010 vs.
buffersink-NV12/P010), Encoder-Optionszweig, `forced-idr` nur NVENC (VAAPI
macht aus einer Anforderung ohnehin IDR), NV-Zweig hat zusätzlich den
`nv_p010`-Shaderpfad.

## B. Befunde

### Hoch — keins

Kein Blocker und kein Beleg für einen offenen Hoch-Schwere-Bug. Die
historischen Viewer-Killer (Mesa-Fuell-OBUs, ungesignalisierter Full-Range,
Sequenzkopf ohne Vollbild, Zeitstempel-Drift, Import-Standbild) sind im
Code gefixt und jeweils mit Messung/Test belegt.

### Mittel

**B1. Reihenfolge-Bug: 10-bit-Importer wird vor der Bittiefen-/Codec-Auflösung gebaut** —
`stream_controller.rs:632-681` vs. `741-754`.
Beleg: `build_importer` (Zeile 668-677) übergibt `params.ten_bit` an
`VaapiImporter::new` → Graph mit `format=p010`. Erst Zeile 741-742 läuft
`codec_fuer_aufloesung`, Zeile 754 koppelt `ten_bit = params.ten_bit && codec == "av1"`.
Der Kommentar in Zeile 751-753 („muss die Bittiefe mitfallen") wird für die
Encoder-Config umgesetzt, aber der bereits gebaute und benutzte Importer bleibt P010.
Auswirkung (Vermutung über den genauen VA-Fehlermodus, die Reihenfolge selbst
ist belegt): Trifft die Kombination „Quelle größer 4096×2304 + 10-bit-Wunsch +
AV1 scheitert an dieser Größe + h264 trägt sie" (genau der Zweck von
`codec_fuer_aufloesung`, `caps.rs:171-185`), öffnet `h264_vaapi` gegen einen
P010-Pool. Mögliche Folgen: Open/Laufzeit-VA-Fehler, oder ein
High-10-H.264-Strom — den `ops/start.rs:100-104` ausdrücklich nie erzeugen
will („High 10 … dekodiert KEIN Browser"). Symmetrisch betrifft es den
NVENC-Pfad (`StagingFormat::P010`, Zeile 646-656).
Lösung: `codec`/`ten_bit`-Auflösung vor `build_importer` ziehen (sie braucht
nur vendor/node/out-Maße, nicht den Importer) — oder beim Codec-Abstieg den
Importer neu bauen.

**B2. SHM-Fallback ist eine totlaufende Verhandlung** — `pipewire_stream.rs:718-722` vs. `745-755`.
Beleg: Ohne Modifier werden `MemFd|MemPtr` angefordert; `process()` verwirft
jeden Nicht-DmaBuf-Buffer mit Einmal-Warnung „SHM-Consumer noch nicht
implementiert".
Auswirkung: Auf einem Compositor ohne DMABUF (VM, Software-Stack) kommt nie
ein Frame an — der Start endet nach 10 s mit „kein Bild vom Compositor"
(`stream_controller.rs:361-364`), ohne dass die Import-Diagnostik (Kandidatenloop)
je erreicht wird. Die Meldung nennt die wahre Ursache nicht.
Lösung: Entweder den SHM-Pfad aus der Verhandlung nehmen (nur DmaBuf
anfordern, wenn kein Modifier verhandelt → klarer Fehler „Compositor ohne
DMABUF") oder implementieren. Kleinster ehrlicher Diff: die Warnung zu einem
`Event::Notice` machen.

### Niedrig

**B3. `av_buffersink_get_hw_frames_ctx`-Eigentum ist FFmpeg-versionengebunden** —
`va_import.rs:255, 411`. FFmpeg 8.1 gibt die Borrow-Ref der Link-Instanz
zurück (`buffersink.c:354-359`) — der Code (nie unref, Kommentar im Drop)
ist in der gebundenen Version korrekt. Andere FFmpeg-Versionen geben eine
neue Ref zurück. Bei einem FFmpeg-Bump: je Importer/Rebuild ein kleines
Ref-Leak. Lösung: Beim Bump diese Stelle gegen `buffersink.c` nachsehen;
Notiz im Drop-Kommentar ergänzen.

**B4. Mid-Stream-Resize: Encoder bleibt am alten Ausgabe-Pool** —
`va_import.rs:271-290` + `stream_controller.rs:796`. Nach Rebuild liefert der
neue Graph einen anderen `hw_frames_ctx`; der Encoder hält die Ref des
ersten. FFmpeg 8.1 prüft `frame->hw_frames_ctx` beim Send nicht (`encode.c:626-641`).
Funktioniert vermutlich, weil Surfaces gleicher Größe/format am selben
Display austauschbar sind — auf echter AMD-HW offenbar ungemessen. Kosten:
alter Pool bleibt bis Stream-ende doppelt belegt (begrenzt).
Lösung: Ein Resize auf AMD-HW einmal gezielt testen.

**B5. Impliziter Modifier als letzte Alternative kann VCN k.o. gehen** —
`egl_modifiers.rs:81-83` vs. `94-101`. Der DCC-Filter säubert nur die
explizite Liste; `DRM_FORMAT_MOD_INVALID` wird immer als letzte Alternative
angeboten. FFmpeg 8.1 fällt bei INVALID auf PRIME-1-Import ohne
Modifier-Angabe zurück (`hwcontext_vaapi.c:1181-1183`) — Layout-Erwissen
liegt dann allein beim Treiber-Import (Fehlerklasse des Support-Falls
2026-07-20, rc=-22). Lösung: im `import()`-Fehlerpfad den Modifier mitloggen
(steht ggf. schon in „Format fixiert").

**B6. `desc.objects[].size` ist eine Schätzung** — `va_import.rs:331-334`:
`offset + height*stride` mit `self.height`, Kommentar „konservativ". Für
blocklineare AMD-Layouts mit Nachlaufbereich theoretisch zu klein. Rein
präventiv: bei Import-EINVAL einmal die exakte Objektgröße durchreichen.

**B7. EAGAIN-Frame-Verwurf ist unsichtbar in den Sekundenstatistiken** —
`encode/mod.rs:457-460` (debug) vs. `stream_controller.rs:1090-1099`. Zweiter
EAGAIN → Frame still verworfen; keine Sekundenzeile zählt den Verwurf.
Lösung: Zähler `window_enc_drops` neben die drei bestehenden setzen (3 Zeilen).

**B8. Paketierer-/Sendefehler beenden die Sitzung hart** — `whip/mod.rs:562`
(`?` in `av1::paketiere`) → `encode/mod.rs:517` → `stream_controller.rs:999`.
Ein malformed-Encoder-Bitstrom wirft und endet im roten Stream-Fehler; der
Import-Pfad hat 2 s Nachsicht, der Paketierer keine. Alternativ: Bild
verwerfen, Zähler wie B7.

## C. Explizit geprüft und ok

- **rc_mode-Mapping AMD**: einzig `CBR`, kein CQP/VBR-Zweig; `coder=cabac`
  korrekt auf H.264 begrenzt; `warn_unknown`/`kennt_option` schließen stille
  av_dict-Verwerfungen für den Messbetrieb aus.
- **`async_depth=1`** und bewusst nicht gesetzte Optionen (`low_power`,
  `compression_level`, `tiles`): messaktengestützt.
- **Keyframe-Mechanik auf VAAPI**: `idr_interval`-Default = IDR an jeder
  GOP-Grenze; PLI-Anforderung → `force_idr` → verlässlich einsteigbares
  Vollbild; `forced-idr` zu Recht NVENC-only. PLI-Drossel koppelt nicht an
  den 60-s-Takt.
- **AV1-Viewer-Freundlichkeit (WHIP-Weg)**: Fuell-OBU-Filter mit AMD-Testfall
  (`pulse-whip/av1.rs:184`, Test 588-607 — die Mesa-CBR-Füllung, gemessen
  99,6 % Bitstromanteil bei stehendem Bild), Sequenzkopf nur am echten
  Vollbild, LEB128-Rundlauf über alle MTUs, N/Z/Y/W-Bits und Marker korrekt,
  pts-Identität 90 kHz↔RTP per Test gehalten.
- **Farbsignalisierung VAAPI**: `out_color_matrix=bt709:out_range=limited`
  im Graphen (gemessen 2026-08-01) und Encoder-VUI für VAAPI jeder
  Bittiefe — konsistent; der alte „jeden AMD-Sender treffende" Fehler ist
  gefixt.
- **10-bit-Durchreichung AMD** (Normalpfad): Probe P010LE ↔ Graph
  `format=p010` ↔ Encoder-Bindung ↔ `ten_bit`-Signalisierung; Fallback
  Codec→Bittiefe gekoppelt (Tests gegen versehentliches 10-bit).
- **Kandidatenloop/Teilerfolg**: Importer-Bau + erster Import atomar; Drop
  räumt Graph/DRM-Frames/Device; halb gescheiterter Rebuild bleibt
  retrybar; kein Doppel-Free, kein halb-konfigurierter Zustand.
- **Modifier/Fourcc-Annahmen**: Fourcc fließt aus der Verhandlung bis in
  Layer-Format und Rebuild-Bedingung; DCC-Filter mit Generationen-Grenze
  GFX12 und Tests; external_only gefiltert; INVALID/Linear als Fallbacks.
- **fd/Resource-Hygiene**: Plane-Drop schließt dup'te fds, Mailbox
  latest-wins, epoch gegen fd-Recycling, eglLibrary nie dlclose, EGL-Displays
  nicht geterminated.
- **lastgrenze**: u64-Multiplikation, Stufenleiter, Vorfallsfall als Test;
  greift auf OUT-Maßen, die mid-stream fix bleiben; 8 bit bewusst nie
  begrenzt; Spiegel-Hinweis auf `settingsCatalog.ts` vorhanden.
- **Zeitachse**: pts aus gemeinsamer Monotonic-Uhr, Duplikat-Regeln,
  Lücken-/Klemm-Zählung; Frame-Import-Ausfall zählt und bricht nach 2 s ab.
- **Teardown-Reihenfolge**: Capture → Audio → `drop(last_hw)` →
  `enc.finish()`; Encoder-Drop vor Importer-Drop — VA-Surfaces werden nicht
  unter dem Encoder weggeräumt.
- **Portal**: Cancel ohne Endlos-Hang, echte Backend-Fehler ≠ User-Abbruch
  (Tests), Session-Close-Guard.

## D. Offene Fragen (nur mit AMD-Hardware/Laufzeit zu klären)

1. **Vorfallpfad 2026-08-20**: Ging der Sender damals über WHIP
   (Fuell-Filter aktiv) oder RTMPS (Filter NEIN — nur der
   MediaMTX-RTMP-Patch 0001 greift), und sah der Zuschauer WHEP oder HLS?
   Davon hängt ab, ob der belegte Fuell-OBU-Fix den Vorfallpfad überhaupt
   deckt.
2. **RTMPS/HLS-AV1-Strom**: Enthält er weiterhin die Mesa-Fuell-OBUs
   (Mux-Weg filtert nicht, `encode/mod.rs:498-503`), und verwirft
   MediaMTX/HLS sie? Ein Mitschnitt `rtmps://` von einer 780M mit stehendem
   Bild würde das in Minuten zeigen.
3. **Mid-Stream-Resize auf AMD** (B4): Fenstergröße während Live ändern →
   läuft der Stream nach dem Graph-Rebuild weiter? Quelltext-plausibel,
   ungemessen.
4. **h264_vaapi mit P010-Eingang** (B1): einen Start „8K/Ultrawide +
   10-bit-Wunsch auf AV1-unfähiger Größe" gezielt provozieren — Open-Fehler,
   VA-Laufzeitfehler oder High-10-Strom?
5. **Impliziter Modifier in der Wildbahn** (B5): taucht in einem „Format
   fixiert"-Log `modifier=0x00ff_ffff_ffff_ffff` auf AMD auf, und liest VCN
   den PRIME-1-Import korrekt?
6. **`PULSE_CAPTURE_10BIT=1` auf einem Compositor, der XB30 wirklich
   liefert** (nicht KWin): der Code behauptet „kommt dort nicht an"
   (`pipewire_stream.rs:311-314`) — für KWin gemessen, für den Rest offen;
   die Stelle würde dann erst beim Import auffallen (`va_import.rs:122`,
   BGR0-sw_format ist eine der unangepassten Stellen).
7. **Interaktion scale_vaapi-Filter-`async_depth` (VPP, Default) ↔
   Encoder-`async_depth=1`** unter VPP-Last — rein optional, nur falls
   Latenzausreißer auf AMD auftreten.
