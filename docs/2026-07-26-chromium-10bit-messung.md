# 10-bit-Farbe, Chromium und der native HQ-Player — Messungen (2026-07-26)

Ausgangsfrage: Kommt bei HQ-Zuschauern echtes 10-bit an, und wenn nicht, wo geht
es verloren? Alle Zahlen auf der Dev-Maschine gemessen: RTX 5080, NVIDIA Open
Kernel Module 610.43.03, CachyOS, KWin 6.7.3 (Wayland), Chromium 150.

Ergebnis vorweg: **Die Linux-Kette traegt durchgehend 10 bit. Der Verlust
passiert ausschliesslich in Chromium** — und damit auch in Electron.

## 1. Die Anzeigekette (alles in Ordnung)

| Stufe | Zustand | Wie belegt |
|---|---|---|
| Link (DP-2, Gigabyte MO27Q28G OLED) | 10 bpc | `/sys/kernel/debug/dri/1/DP-2/output_bpc` -> `Maximum: 10` |
| Scanout-Plane | `AB30` (ABGR2101010) bzw. `AB4H` (ABGR16161616F) | `/sys/kernel/debug/dri/1/state` |
| KWin-Composition | >= 10 bit in **jeder** getesteten Konfiguration | dito |
| mpv (`--vo=gpu-next`) | reicht 10 bit durch | Sichttest, s. u. |
| **Chromium** | **quantisiert auf 8 bit** | Wayland-Protokollmitschnitt |

Zwei Beobachtungen, die man leicht falsch deutet:

- **Der HDR-Schalter ist irrelevant.** DP-2 lief mit `AB30`/`AB4H` auch bei
  ausgeschaltetem HDR. Bittiefe und HDR sind unabhaengig — HDR aendert
  Uebertragungsfunktion, Gamut und Metadaten, nicht die Quantisierung.
- **Die KDE-Option "Farbgenauigkeit" schaltet zwischen fp16 und 10-bit-Integer**,
  nicht zwischen 10 bit und 8 bit: "Genauigkeit bevorzugen" ergab `AB4H` (fp16),
  "Effizienz bevorzugen" `AB30` (10 bit). Beide tragen die Testbilder verlustfrei.
  Eine fruehere Messung zeigte DP-1 einmalig auf `AR24` (8 bit) bei unveraenderter
  Einstellung — KWin waehlt das Format also nicht rein statisch. Warum, ist offen.

### Testbild

`ffmpeg`-erzeugt, ein 10-bit-Video mit zwei Haelften desselben dunklen
Graustufenverlaufs (8-bit-Aequivalent 16 bis 80):

- oben auf 8-bit-Stufen quantisiert: 65 Stufen a 40 px
- unten volle 10-bit-Aufloesung: 257 Stufen a 10 px

Beide Fassungen (FFV1 lossless fuer mpv, VP9 Profile 2 lossless fuer den
Browser) waren nach dem Encodieren **bitgenau** identisch mit dem Master.

Ablesen: Rasten oben und unten auf **dieselben** 40-px-Kanten ein, quantisiert
etwas in der Kette auf 8 bit. Wichtig: `--dither=no` in mpv, sonst kaschiert
das Dithering den Unterschied und man bekommt ein falsches Positiv. Und niemals
per Screenshot beurteilen — der ist selbst 8 bit.

Ergebnis: mpv zeigte oben Streifen, unten glatt. Chromium zeigte **beide**
Haelften gestreift.

## 2. Chromium — wo genau es verloren geht

`WAYLAND_DEBUG=1` auf einem frischen Profil, drei Konfigurationen:

| Lauf | Surface meldet | Pufferformat |
|---|---|---|
| HDR aus, Standard | sRGB | `AB24` (ABGR8888) — 8 bit |
| HDR aus, `--force-color-profile=scrgb-linear` | sRGB | `AB24` — 8 bit |
| **HDR an auf DP-2** | **PQ (ST 2084)** | `AB24` — **8 bit** |

Im HDR-Fall baut Chromium eine vollstaendige HDR-Bildbeschreibung
(`set_primaries` mit den nativen Panel-Primaervalenzen, `set_tf_named(11)` = PQ,
`set_luminances(0, 1000, 295)`, `set_max_cll/fall(295)`) — und schickt sie in
einem 8-bit-Puffer. PQ ueber 8 bit ist die pathologische Kombination.

Ausgeschlossen wurde:

- **XWayland** — Chromium hatte zwei Wayland-FDs und null X11-FDs, laeuft nativ.
- **Protokoll fehlt** — `wp_color_manager_v1` und `zwp_linux_dmabuf_v1` werden
  gebunden.
- **Compositor als Grenze** — KWin bot ueber `wl_shm` unter anderem
  `ABGR16161616` und `XBGR16161616` an. Die 8 bit sind Chromiums Wahl.

Passender offener Chromium-Bug: *Severe banding on Wayland with HDR enabled*
(Issue 503402063). Titel deckt sich; Inhalt und Status waren ohne Login nicht
einsehbar.

Recherche-Befund: Chromiums High-Bit-Depth-Pfad in Ozone (`RGBA_F16` ueber
`DRM_ABGR16161616F`) wurde als ChromeOS/Lacros-**HDR**-Funktion eingefuehrt. Ein
SDR-Pfad mit erhoehter Bittiefe ist nicht dokumentiert, und
`--force-color-profile` aendert den Arbeitsfarbraum, nicht die Bittiefe.

## 3. Decode: Chromium nutzt kein NVDEC

| Fall | NVDEC (`dec`) | CPU-Zeit / 10 s |
|---|---|---|
| `ffmpeg -hwaccel cuda` (Kontrolle) | 50 % | — |
| `ffmpeg` ohne hwaccel (Kontrolle) | 0 % | — |
| Chromium, H.264 1440p60 | 0 % | 4,63 s |
| Chromium, AV1 1440p60 | 0 % | — |
| Chromium + VA-API-Flags, `LIBVA_DRIVER_NAME=nvidia`, `--use-gl=egl` | 0 % | 5,13 s |

Der Zaehler ist validiert (Kontrolle schlaegt an), und dass wirklich abgespielt
wurde, wurde ueber das DevTools-Protokoll geprueft (Fenstertitel `PLAYING`) —
genau die Falle, in die ein erster Versuch mit `mpv --vo=null` gelaufen war.

`vainfo` meldet den NVDEC-Treiber mit Profilen fuer H.264, HEVC Main/Main10,
VP9 Profile 0/2 und AV1 Profile 0. Die Hardware koennte also.

**Einschraenkung:** Gemessen ist der `<video>`-Pfad mit lokalen Dateien, nicht
WHEP. WebRTC hat in Chromium eine eigene Decoder-Kette. Auf Windows duerfte das
Bild ohnehin anders aussehen (D3D11-Videodecode) — beides ungemessen.

## 4. Folgerungen

1. **Electron ist Chromium.** Die Decke gilt fuer die Desktop-App genauso wie
   fuer Browser-Zuschauer.
2. **10-bit-Encoding im Sidecar bleibt sinnvoll**, aber als
   Kompressionsmassnahme (praeziseres Encoder-Rechnen, weniger Banding aus der
   Kompression), nicht als Wiedergabemerkmal.
3. **HDR an Browser-Zuschauer waere aktiv schaedlich** — PQ in 8 bit ist
   sichtbar schlechter als sauberes SDR.
4. Deshalb `streaming/pulse-player/`: ein Player mit eigener Surface waehlt
   Pufferformat und Decoder selbst. Rein additiv, der `<video>`-Weg bleibt der
   Standard.

## 5. Nebenbefund: Codec-Wahl ignoriert den Zuschauer

`web/src/lib/stream/settings.svelte.ts:343-345` waehlt AV1, sobald die GPU **des
Senders** es encodieren kann. Die Decode-Faehigkeit des Zuschauers geht nicht
ein. Da Chromium ohnehin in Software dekodiert, traegt ein Zuschauer auf
schwaecherer Hardware die volle AV1-Software-Decode-Last bei 1440p60.

Auf Wunsch des Users **bewusst nicht geaendert** (2026-07-26). Der Empfaenger
kann den Codec ohnehin nicht selbst waehlen — ein Encode, ein Bitstrom, und
serverseitiges Transkodieren ist Anti-Pattern (`PLAN.md` §12) und ohne GPU auf
den VPS nicht machbar. Realistische Hebel lägen alle auf der Senderseite
(zweiter paralleler Encode, konservativerer Default, oder nur anzeigen).

## 6. Offen

- Dasselbe am echten WHEP-Stream messen statt an lokalen Dateien.
- Firefox mit `gfx.wayland.hdr=true` gegenpruefen.
- Die Render-Etappe des Players messen — das ist die Zahl, die in
  `2026-07-21-remote-control-latenz-messung.md` §2.4 noch als Schaetzung steht.

## Reproduzieren

Testbild-Erzeugung, Messbefehle und Auswertung sind in dieser Datei bewusst
nicht als Skript abgelegt (Wegwerf-Prototypen, wie beim Fernsteuerungs-Spike).
Die entscheidenden Werkzeuge: `sudo cat /sys/kernel/debug/dri/1/state`,
`modetest -M nvidia-drm -c`, `WAYLAND_DEBUG=1`, `nvidia-smi dmon -s u`,
`/usr/include/libdrm/drm_fourcc.h` zum Aufloesen der Formatkuerzel.
