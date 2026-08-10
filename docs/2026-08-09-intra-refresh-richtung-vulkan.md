# Intra-Refresh Hebel 1 (Richtung) über Vulkan auf NVIDIA — Klärung + Stand

**Datum:** 2026-08-09 · **Branch:** `feat/nvenc-intra-refresh-zyklus`

Zusammenfassung der Erkenntnisse aus der Arbeit an Intra-Refresh auf diesem
Branch. Anlass: die Frage, ob der sichtbare Auffrisch-Streifen durch eine
andere **Richtung** (Spalten statt Zeilen) gemildert werden kann — und auf
welchem Pfad das auf NVIDIA überhaupt geht. Die kurze Antwort: über die NVENC-API
nicht, über Vulkan sehr wahrscheinlich schon.

## UPDATE 2026-08-10 — VERIFIZIERT: COLUMN läuft, aber NVIDIA caps-query ist broken

**COLUMN-Intra-Refresh encodiert erfolgreich auf der RTX 5080.** Gegen den
neuen produktiven Patch `streaming/ffmpeg-patches/0004-vulkan-encode-intra-refresh.patch`
(Vulkan-Teil aus dem Labor, COLUMN-first, gegen `n8.1.1` portiert): `h264_vulkan
-intra_refresh 1 -intra_refresh_period 30` öffnet, loggt
`Intra refresh: mode 0x8, cycle 30 frames` (= `BLOCK_COLUMN_BASED_BIT_KHR`,
0x8 in Vulkan-Headers ≥ 1.4) und schreibt 60 gültige Frames. Die gestrige
„Richtung nicht stellbar"-Aussage gilt **nur für die NVENC-API** — über Vulkan
geht COLUMN. Hebel 1 ist also erreichbar.

**Aber: NVIDIA 610.x liefert eine kaputte Vulkan-Video-caps-Query.** Dasselbe
Phänomen, das die gestrige isolierte `vulkaninfo`-Probe ins Leere laufen ließ,
blockiert auch FFmpeg `n8.1.1` auf dieser Hardware:

- `enc_caps.supportedEncodeFeedbackFlags == 0x0` (gemeldet), obwohl die Hardware
  `BUFFER_OFFSET | BYTES_WRITTEN` (0x3) kann. Der strikte Check in
  `vulkan_encode.c` bricht deshalb ab — **bevor Intra-Refresh überhaupt
  drankommt**, und er bricht *jeden* Vulkan-Encode ab, nicht nur Intra-Refresh.
- `ir_caps.intraRefreshModes == 0x1` (nur `PER_PICTURE_PARTITION`), COLUMN (0x8)
  wird nicht gemeldet, obwohl die Hardware es ausführt.

Beides zusammen: ein reiner `0004`-Bau (ohne Workaround) öffnet den Encoder auf
der RTX 5080 **nicht**. **FFmpeg 9.0 (System-FFmpeg dieser Maschine) bekommt die
caps korrekt** und encoded ohne Workaround — der Bug liegt im `n8.1.1`-Code-Pfad
der caps-Query (struct-Größen / Loader-Reihenfolge), den 9.0 geändert hat.

**Workaround-PoC (im Cache-Bau verifiziert, NICHT im Repo-Patch):** feedback-Check
lockern (Warning statt Abbruch, Query-Pool forciert weiter 0x3) + COLUMN hart
setzen (Moduswahl durch `ctx->ir_mode = COLUMN` ersetzen). Encode läuft, Output
gültig. Beweist: die Hardware kann beides, nur die caps-Query meldet es nicht.

**Damit steht eine Entscheidung an** (beide Pfade führen zu COLUMN in Produktion):

1. **Workaround-Patch `0005` (auf `n8.1.1`):** vendor-bedingt (NVIDIA +
   `supportedEncodeFeedbackFlags == 0` als Broken-Indikator), forciert
   feedback-flags + COLUMN. Schnell, NVIDIA-spezifisch, hacky (blind gesetzte
   Werte statt caps). Greift nicht auf AMD/Intel.
2. **FFmpeg-Upgrade auf ≥ 9.0:** bekommt die caps korrekt, kein Workaround nötig,
   upstream-kompatibel. Aber massiver Eingriff: `ffmpeg-next` 8.1→9.x-Binding,
   alle 4 Patches neu portieren, Flatpak-FFmpeg-Modul bumpen, Sidecar, CLAUDE.md.

Bis die Entscheidung fällt, ist der Sidecar-Anbindung (Task 5) vorgegriffen —
sie ist in beiden Szenarien nötig, aber die `ffmpeg-next`-Version steht erst
danach fest. Der `0004`-Patch im Repo bleibt **sauber** (COLUMN-first, kein
Workaround) — er ist korrekt für Hardware mit funktionierender caps-Query; der
NVIDIA-610.x-Workaround wird separater `0005`.

Vorangegangen ist die externe Best-Practice-Recherche
`docs/2026-08-09-intra-refresh-best-practices-recherche.md` (Branch
`docs/intra-refresh-recherche`), die drei Hebel nennt:

1. **Richtung** (`ROLLING_COLUMN` statt `ROLLING_ROW`)
2. **Zykluslänge** von der GOP entkoppeln
3. **QP-Bonus** für den Streifen

## Was auf diesem Branch gebaut ist (Hebel 2, NVENC)

Patch `streaming/ffmpeg-patches/0003-nvenc-rollender-intra-refresh-period-cnt.patch`:
Entkoppelt `intraRefreshPeriod`/`intraRefreshCnt` in `nvenc.c` von `gopLength`
(dort stand hart `Period = gopLength; Cnt = gopLength-1`). Zwei neue Optionen,
Default `0` = byte-identisch mit dem heutigen Verhalten. Gegen FFmpeg `n8.1.1`
(Commit `239f2c733`) entwickelt und `git apply --check`-geprüft. Gegenprobe in
`bootstrap-ffmpeg.sh` um NVENC bedingt erweitert (nur wenn `ffnvcodec`).

**Verifiziert (diese Maschine, RTX 4080/4090):**
- Optionen in `av1_nvenc`/`h264_nvenc`/`hevc_nvenc` sichtbar (`-h encoder=…`).
- Sidecar + Player korrekt ans gepatchte FFmpeg gelinkt (`libavcodec.so.62`).
- Dev-Stack läuft, `health` meldet `intra_refresh: true`.

**Offen auf diesem Branch:**
- Kein auflösungsabhängiger Default (AMD-Formel Bildbreite÷16) — nur manuelle
  Option. Siehe „Warum nicht wie in der .md" unten.
- Empirische Messung (ändert die kürzere Periode das Streifen-Artefakt?) steht
  aus; das Labor-Mess-Setup (`pulse-hq-labor`/`intraref-verlust.py`) ist
  kaputtgegangen (s. „Labor einfrieren").

## Hebel 1 (Richtung) — die Klärung

### NVENC-API: Richtung ist nicht stellbar

Ursprüngliche Annahme war „NVENC kann die Richtung nicht", gestützt auf einen
Blick in `nvEncodeAPI.h`. Nach gründlicherer Recherche stimmt das **im Ergebnis
für die NVENC-API**, der Grund ist aber ein anderer und tieferer:

- `NV_ENC_CONFIG_INTRA_REFRESH` hat nur `intraRefreshPeriod` + `intraRefreshCnt`,
  kein Richtungs-Feld. Die `direction`-Bits im Header beziehen sich auf
  *Motion-Estimation* (L0/L1), nicht auf Refresh.
- Offizieller NVENC Programming Guide: *„Intra Refresh behavior is slice based
  for H.264/HEVC and tile based for AV1"* — NVENC denkt also **gar nicht** in
  Zeilen/Spalten wie VAAPI, sondern frischt konsekutive Slices/Tiles auf. Die
  Richtung ist treiber-intern, nicht anwendungsseitig.
- Kein dokumentierter Workaround (kein „erzwing MB an (x,y) als intra"; x264
  kann das, NVENC nicht).

→ Hebel 1 ist über die NVENC-API (`h264_nvenc`/`av1_nvenc`) eine Sackgasse.

### Vulkan: Richtung IST stellbar — und der Extension ist da

Die Extension [`VK_KHR_video_encode_intra_refresh`](https://docs.vulkan.org/refpages/latest/refpages/source/VK_KHR_video_encode_intra_refresh.html)
definiert eigene Modi, darunter **beide** Richtungen:

- `VK_VIDEO_ENCODE_INTRA_REFRESH_MODE_BLOCK_ROW_BASED_BIT_KHR`
- `VK_VIDEO_ENCODE_INTRA_REFRESH_MODE_BLOCK_COLUMN_BASED_BIT_KHR` ← Spalten

`vulkaninfo` auf dieser Maschine bestätigt: `VK_KHR_video_encode_intra_refresh`
(rev 1) **vorhanden**, dazu `video_encode_h264`/`av1`/`h265`. Laut NVIDIA-Doku
trägt Treiber 570+ auf RTK row **und** column.

### Pulse hat schon einen Vulkan-Intra-Refresh-Patch

`streaming/win-hq-labor/ffmpeg-patches/0001-vulkan-encode-intra-refresh.patch`
patcht `vulkan_encode.c` und nutzt genau diesen Extension
(`VIDEO_ENCODE_INTRA_REFRESH_INFO_KHR`, `ir_caps`, `FF_VK_EXT_VIDEO_ENCODE_INTRA_REFRESH`).
Er wählt aktuell aber **ROW** — Kommentar im Patch:

> *„Prefer a row based refresh: it is the one form that maps to a predictable
> band walking down the picture, and it is what the VAAPI path produces, so
> measurements stay comparable. Block based is accepted as a fallback…"*

ROW wurde also gewählt, um mit VAAPI vergleichbar zu bleiben — **nicht**, weil
COLUMN nicht ginge. Der Fallback im Patch ist `ROW → BLOCK → PER_PICTURE_PARTITION`;
**`COLUMN` fehlt komplett**. Hebel 1 wäre dort einträglich.

**Aber:** Vulkan-Encode ist bei Pulse aktuell **nur Labor** — CLAUDE.md sagt
*„Pulse uses NVENC/VAAPI, never Vulkan encode"*, der Patch liegt in
`win-hq-labor/`, nicht produktiv.

## Offen / nächste Schritte (Hebel 1 über Vulkan)

1. **caps-Query zur Laufzeit:** ob die RTX-Karte für das Profil (H.264/AV1) den
   column-mode in `ir_caps.intraRefreshModes` tatsächlich meldet. Vulkan-Encode
   auf NVIDIA landet auf derselben NVENC-Hardware — das Risiko bleibt, dass die
   Hardware column verweigert, obwohl der Extension gemeldet wird. Nur zur
   Laufzeit sicher.
2. **Vulkan-Encode-Pfad produktiv machen** (Sidecar/Vulkan-Pipeline statt NVENC/
   VAAPI) — das ist die Hauptarbeit, kein schneller Patch.
3. **Patch erweitern:** COLUMN als Option/Default wählen, wenn `ir_caps` es
   anbietet; ROW als Fallback.

## Warum nicht „wie in der .md vorgeschlagen" (AMD-Formel)

Die Forschungs-Doku schlug für Hebel 2 vor: *„mindestens auflösungsabhängig
(AMD-Formel Bildbreite÷16)"*. Gebaut wurde nur die Voraussetzung (Period/Cnt als
entkoppelte Optionen), **nicht** der auflösungsabhängige Default. Grund: Plan-
Entscheidung „erst Optionen + manuell messen, bevor eine Standard-Logik
festgezurrt wird". Die AMD-Formel ist zudem eine AMD/AMF-Faustregel in
Makroblock-Spalten; auf NVENCs Frame-basierte `period`/`cnt` ist sie ein
Startpunkt, kein bewiesener Standard. Nachrüstbar, wenn gewünscht.

## Labor einfrieren

Das Labor-Mess-Setup (`streaming/hq-labor/`, `pulse-hq-labor`,
`streaming/testbench/intraref-verlust.py`) ist **kaputtgegangen**: das
Labor-Binary ist gegen eine alte FFmpeg-Version gelinkt (`libavutil.so.60 not
found`) und crasht beim Start; `hq-bauen.sh` baut es nicht. Zudem streamt das
Mess-Script gegen einen Remote-Labor-MediaMTX (`PULSE_FERN_*`-Credentials).
Entscheidung (2026-08-09): Labor **nicht mehr nutzen**. Endgültig löschen vs.
drinlassen ist ein separater Cleanup-Schritt (viele Verdrahtungsstellen:
`intraref-verlust.py`, `fern-harness.py`, `win-hq-labor/`, README-Verweise).
Empfehlung: eigener Branch, nachdem entschieden ist.

## Quellen

- [NVENC Video Encoder API Programming Guide](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html)
- [NVIDIA Developer Forums — NVENC HEVC and intra refresh](https://forums.developer.nvidia.com/t/nvenc-hevc-and-intra-refresh/69481)
- [AMD GDR Intra Refresh (horizontal/vertical, zum Vergleich)](https://docs.amd.com/r/en-US/pg252-vcu/GDR-Intra-Refresh)
- [VK_KHR_video_encode_intra_refresh — Mode Flags](https://vkdoc.net/man/VkVideoEncodeIntraRefreshModeFlagBitsKHR)
- [Khronos — Vulkan Video Encode Intra-refresh Extension](https://www.khronos.org/blog/khronos-announces-vulkan-video-encode-intra-refresh-extension)
- [NVIDIA Vulkan Driver Support](https://developer.nvidia.com/vulkan-driver)
- Eigener Patch (Labor): `streaming/win-hq-labor/ffmpeg-patches/0001-vulkan-encode-intra-refresh.patch`
