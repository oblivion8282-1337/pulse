# VAAPI → wgpu über DMA-BUF — die Probe vor der dritten Brücke

Machbarkeitsnachweis, kein Workspace-Mitglied. Er beantwortet die Frage, ob die
dritte Zero-Copy-Brücke des Players (VAAPI, also AMD und Intel unter Linux) den
fertigen Helfer aus wgpu-hal 30 benutzen kann — oder ein eigenes `VkImage`
bauen muss wie die CUDA-Brücke daneben.

```bash
cargo build --release
./target/release/vaapi-dmabuf-export datei.mp4 [weitere …]
```

Testmaterial erzeugt man sich mit dem System-FFmpeg, z. B.:

```bash
ffmpeg -f lavfi -i testsrc2=size=1920x1080:rate=60:duration=2 \
  -vf format=p010,hwupload -vaapi_device /dev/dri/renderD128 \
  -c:v av1_vaapi -b:v 4000k probe-av1-10bit.mp4
```

## Was sie in zwei Schritten misst

**Schritt 1 — die Gestalt.** `av_hwframe_map` nach `AV_PIX_FMT_DRM_PRIME`, dann
den `AVDRMFrameDescriptor` ausdrucken: Objekte, Layer, Planes je Layer,
Modifier, Fourccs, Versätze, Zeilenlängen. Entscheidend ist **Planes je Layer**:
`texture_from_dmabuf_fd` (wgpu-hal 30, `src/vulkan/device.rs:525`) nimmt
ausdrücklich nur einplanige DMA-BUFs.

**Schritt 2 — der Inhalt.** Beide Layer als wgpu-Texturen einhängen,
zurücklesen und **byteweise** gegen `av_hwframe_transfer_data` desselben Bildes
vergleichen — also gegen genau den langsamen Weg, den die Brücke ersetzen soll.

## Zwei Fallen, die hier schon zugeschnappt sind

**Der Standard-Decoder taugt nicht.** `avcodec_find_decoder` liefert für AV1
`libdav1d`, und das kennt keine hwaccel — der VAAPI-Weg käme nie zustande, und
die Probe meldete wahrheitsgemäß „nicht VAAPI", was leicht als „AMD kann kein
AV1" missverstanden wird. Der Decoder muss **benannt** werden (`av1`, `h264`),
genau wie im Player (`decode.rs::candidates_mit`).

**Das Flag ist `AV_HWFRAME_MAP_READ`, nicht `AV_HWFRAME_MAP_DIRECT`.** `DIRECT`
wird auf diesem Weg gar nicht ausgewertet (es gilt nur für
`vaapi_map_to_memory`). `READ` setzt `VA_EXPORT_SURFACE_READ_ONLY` **und** löst
`vaSyncSurface` aus — die dekodierseitige Synchronisation ist damit erledigt,
ohne dass die Brücke sie selbst bauen muss. Das ist der Unterschied zur
CUDA-Brücke, die dafür `cuCtxSynchronize` fährt.

## Ergebnis auf Radeon 780M (2026-08-10)

Volle Zahlen in
`streaming/testbench/profiles/player-2026-08-10-vaapi-dmabuf-export.json`.
Kurz: ein Objekt, zwei Layer, **je eine Plane**, Gestalt über alle Bilder
stabil, Modifier `0x0200000010401b04` ohne Metadaten-Plane — der wgpu-Helfer
trägt. Beide Ebenen kamen in allen drei Fällen (H.264 8 bit, AV1 8 bit, AV1
10 bit) **bitgenau** an.

Damit sind die beiden Risiken erledigt, die vorher nicht zu belegen waren: der
Versatz des Chromas (beide Layer teilen einen Dateideskriptor, das Chroma sitzt
mitten im Puffer) und der Layout-Übergang aus `UNDEFINED`, der den Inhalt hätte
verwerfen dürfen.
