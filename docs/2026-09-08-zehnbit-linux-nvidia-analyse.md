# 10 bit auf Linux/NVIDIA: was es kostet, wo es herkommt, was noch geht

Stand 2026-09-08. Anlass war die Frage, ob AV1 in 10 bit gegenüber 8 bit
„leistungstechnisch einen Unterschied macht, in allen Bereichen". Die erste
Antwort darauf enthielt drei falsche und zwei unbelegte Aussagen, alle aus
veralteten Kommentaren und Dokumenten im Repo übernommen. Dieses Dokument
hält fest, was danach **am Code und an den Messakten** geprüft wurde, was
davon gemessen und was gefolgert ist, und welche Hebel am Linux-Sidecar
noch offen sind. Maschine: RTX 5080, Treiber 610.57.04, CachyOS, **niri 26.04**
(die Messakten vom Juli/August entstanden auf derselben Maschine unter KDE).

Verwandt: `2026-07-26-hq-10bit-befund.md` (warum 10-bit-Encode einer 8-bit-Quelle
hilft), `2026-07-26-chromium-10bit-messung.md` (die Anzeigekette unter KDE),
`2026-07-30-linux-hq-sidecar-messbegruendungen.md` (Encoder-Werte),
`streaming/testbench/profiles/player-2026-08-06-bildweg-kosten.json` und
`player-2026-08-11-zerocopy-nvidia.json` (Player-Kosten je Bild).

## 1. Drei Behauptungen, die im Repo falsch standen

Alle drei sind auf dem Branch `docs/zehnbit-behauptungen` korrigiert
(Commit `f785d08d`).

| Behauptung | Wo sie stand | Was stimmt |
|---|---|---|
| „VAAPI hat keinen 10-bit-Zweig" | `linux-hq-sidecar/README.md:57` (2026-07-31), `stream_controller.rs:230` | `va_import.rs:215` wählt seit 2026-08-01 `p010` als `scale_vaapi`-Ziel; `stream_controller.rs:719` sagt es an derselben Datei richtig |
| „425 Anforderungen in einem Lauf" mit Verweis auf `browser-2026-08-01-windows-av1-10bit.json` | `keyframe.rs:48-51` und Test-Kommentar | Die Zahl steht in keiner Messakte. Belegt: 61 Anforderungen in 12 s bei erzwungenem Software-Decode, kein einziges Bild (Akte vom 2026-08-01); 65 je Lauf nach Rückfall des Hardware-Decoders mitten im Strom (`amd-2026-08-02-qualitaet-und-browser.json`) |
| „dav1d kann kein 10 bit" | `keyframe.rs` | libwebrtcs dav1d-**Anbindung** lehnt `bpc != 8` ab (`browser-2026-07-31-fec-und-codecs.json`); dav1d selbst kann 10 bit |

Zwei weitere Aussagen aus der ersten Antwort waren **unbelegt** und sind
zurückgezogen: „Herstellerangaben 10 bis 30 % mehr Encoder-Zeit" (steht
nirgends im Repo) und „10 bit kostet den Decoder das 1,5- bis 2-fache an
Zyklen" (Faustregel im Kommentar von `settingsCatalog.ts:191`, keine
Messung; der Vorfall vom 2026-08-20 hat keine Messakte, nur Commit
`abd9f1d6`).

## 2. Warum 10 bit beim Zuschauer mehr kostet

**Es sind Bytes, nicht Rechenarbeit.** P010 legt 10 bit in ein 16-bit-Wort,
sechs Bit bleiben leer. Ein 1080p-Bild wächst von 2,97 auf 5,93 MiB, exakt
Faktor 2. Jeder speichergebundene Posten folgt dieser Zahl
(`player-2026-08-06-bildweg-kosten.json`, RTX 5080, 1080p60):

| Posten je Bild | 8 bit | 10 bit |
|---|---|---|
| Hochladen in die Textur | 1,1 ms | 2,2 ms |
| Konvertieren | 166–218 µs | 369–432 µs |
| Bild-Abdruck | 209–243 µs | 453–472 µs |
| Rückholung D3D11VA | 3,5 ms | 5,2–5,5 ms |

`write_texture` schafft 2,8–2,9 GB/s bei jeder Auflösung, „je Byte exakt
dasselbe" — es gibt keine 10-bit-Strafe im Treiber, nur doppelt so viele
Bytes.

**Der Decoder selbst kostet rund 13 % mehr.** Mit Zero-Copy, also ohne
Speicherweg, dekodiert die RTX 5080 8 bit in 2,60 ms und 10 bit in 2,95 ms
(`player-2026-08-11-zerocopy-nvidia.json`). Auf dem alten cuvid-Weg waren es
4,35 gegen 5,90 ms; die Differenz bestand fast ganz aus der Rückholung der
doppelten Bytes. HDR obendrauf kostet nichts Messbares.

**Das ist im ausgelieferten Player längst der Normalweg.** Seit 2026-08-11
steht auf Windows der native Decoder mit D3D11VA vor cuvid
(`decode.rs:33-37`), auf Linux gibt es die CUDA- und die VAAPI-Brücke
(`zerocopy/linuxweg.rs`), Zero-Copy ist die Vorgabe (`zerocopy/mod.rs:97`),
und der Bild-Abdruck rechnet auf der GPU (`render/abdruck.rs`). Was von der
10-bit-Mehrlast beim Zuschauer bleibt, sind die 13 % im Decoder und der
doppelte Texturverkehr im Renderer.

**Browser** haben keinen Mehraufwand, sondern einen harten Ausfall im
Software-Weg (libwebrtc, s. o.). Mit Hardware-Decode liefen unter Windows 646
statt 717 Bilder in 12 s, rund 10 % weniger.

**Sender:** kein 8-gegen-10-Vergleich im selben Aufbau. Einzige Zahl: 17,1 ms
Encode-Latenz für AV1 10 bit auf einer Radeon 780M
(`amd-windows-2026-08-01-codecs-und-10bit.json`). Was 10 bit am Sender
strukturell mehr kostet, steht in Abschnitt 3.

**Netz:** gleiche Bitrate durch CBR (`opts.rs`, NVENC `rc=cbr`, VAAPI
`rc_mode=CBR`), deshalb gleiche Paketmenge — Folgerung, nicht gemessen.

## 3. Der 10-bit-Weg des Linux-Sidecars auf NVIDIA, Stufe für Stufe

Zwei Leseläufe (Bildweg und Aufnahme) plus eigene Prüfung am FFmpeg-Quelltext
der gepinnten n8.1.1. Für den Import selbst gibt es **keine Linux-Messakte**;
alle Kostenangaben unten sind aus dem Code abgeleitet.

| Stufe | Je Bild | 10 bit gegenüber 8 bit |
|---|---|---|
| Aufnahme (PipeWire-Faden) | Puffer holen, fds dup'en, in Ein-Slot-Postfach legen, **Puffer sofort zurückgeben** (`pipewire_stream.rs:738-799`) | gleich |
| Import (Takt-Faden) | EGLImage aus Cache; **zwei Shader-Durchgänge** (Y in R16, UV in RG16 mit 2×2-Mittel) statt eines Blits; je Durchgang `glFramebufferTexture2D` + `glCheckFramebufferStatus` (`nv_p010.rs:318-360`) | zwei Rasterdurchgänge, zwei Treiber-Rundläufe mehr |
| CUDA-Kopie | eine Map-Runde, **zwei** `cuMemcpy2D`, dann `cuCtxSynchronize` (`nv_import.rs:1097-1176`) | eine Kopie mehr; aber 3 statt 4 Byte je Bildpunkt, ein Viertel weniger Daten |
| Encode | `avcodec_send_frame` liefert mit `delay=0` das Paket im selben Aufruf, 2,9 ms bei 1440p (2026-07-26) | 8-bit-Vergleich fehlt |
| WHIP | AV1-Paketierer, Pacer auf eigenem tokio-Task | gleich |

Was **schon gut** ist und nicht erneut vorgeschlagen werden soll: EGLImage und
Textur pro Capture-Puffer gecacht mit Epochen-Schutz; beide P010-Ebenen in
einer Map/Sync-Runde; Texturfilter einmal beim Anlegen; Ein-Slot-Postfach
statt FIFO; Latenzstempel vor `send_frame`; Ton als eigene Spur; Pacer mit
absoluten Zeitpunkten; Preset-Leiter und Tunes durchgemessen. Der Muxer-Weg
(`mux_writer.rs`, `max_interleave_delta`, `tcp_nodelay`) läuft für Nutzer seit
dem 2026-08-18 nicht mehr.

## 4. Hebel, nach Nutzen sortiert

**4.1 Den P010-Weg durch `highbitdepth=1` ersetzen.** `av1_nvenc` in der
gepinnten FFmpeg hat die Option „Enable 10 bit encode for 8 bit input"
(`nvenc_av1.c:94`). Der NVENC-Header (SDK 13, `nvEncodeAPI.h:2116-2119`)
sagt für AV1: „HW will do the bitdepth conversion internally from
inputBitDepth to outputBitDepth, support for 8 bit input to 10 bit encode".
`nvenc.c:1725-1726` setzt dann `inputBitDepth=8`, `outputBitDepth=10`, und
der Eingang darf ARGB bleiben. Da die Aufnahme ohnehin 8 bit ist, fiele weg:
beide Shader-Durchgänge, die zweite CUDA-Registrierung, die zweite Kopie, und
die Farbwandlung ginge zurück in die Encoder-Hardware. Der 10-bit-Weg kostete
dann exakt dasselbe wie der 8-bit-Weg.

Offen, nur durch Messung zu klären: ob NVENC ARGB-Eingang plus 10-bit-Ausgang
tatsächlich öffnet; ob der Strom echte 10 bit trägt (Rest-Verteilung Y mod 4,
`zehnbit-praezision.py`); ob das Banding-Ergebnis am Testbild
(`pulse-player/testbild.py`) dem Shader-Weg gleichkommt — NVENCs interne
Wandlung könnte Y auf 8-bit-Stufen runden, bevor sie hochschiebt; und welche
Farbmatrix NVENC bei RGB-Eingang nimmt (der 8-bit-Weg signalisiert heute
nichts, der 10-bit-Weg BT.709). **Testbar ohne Umbau:** 8 bit anfordern und
`PULSE_ENCODER_OPTS=highbitdepth=1` setzen; `warn_unknown` meldet, falls die
Option nicht ankommt.

**Einschränkung für niri, s. Abschnitt 5:** dieser Weg kappt an der
RGBA8-Staging. Sollte der Compositor je echte 10-bit-Puffer liefern, trägt sie
nur der Shader-Weg.

**4.2 `cuCtxSynchronize` je Bild streichen.** Der Kommentar in
`nv_import.rs:1157` begründet den Sync damit, dass NVENC „auf FFmpegs eigenem
Stream" liest. Das stimmt nicht: `hwcontext_cuda.c:392` setzt
`hwctx->stream = NULL`, FFmpeg nutzt den Legacy-Default-Stream, denselben
wie unsere `cuMemcpy2D` (Stream-Argument NULL). Die Reihenfolge ist damit
schon durch den Stream garantiert. Den Aufnahmepuffer schützt der Sync auch
nicht, weil der schon im PipeWire-Rückruf zurückgegeben wird. Übrig bleibt
eine geräteweite Wartepause auf dem Takt-Faden, die jede fremde CUDA-Arbeit
im Prozess mit abwartet. Nutzen: die GPU-Zeit von Shader und Kopien
verschwindet aus dem CPU-Budget des Takt-Fadens; Größe ungemessen, bei
144 fps und 6,9 ms Budget relevant. Risiko gering, solange die
Map/Unmap-Paare stehen bleiben — die sind die eigentliche GL↔CUDA-Sperre.

**4.3 Der Aufnahmepuffer geht zurück, bevor er gelesen wird.** Kein
Leistungs-, ein Korrektheitsfund, für 8 und 10 bit gleich. Der Compositor darf
den Puffer überschreiben, während der Takt-Faden ihn Millisekunden später
über das gecachte EGLImage liest („eine LIVE-Sicht", `nv_import.rs:756`).
Sichtbar wäre das als Reißen oder Mischung zweier Bilder, nie als Fehler. Ob
es auftritt, hängt an der Puffermenge des Compositors, und die wird weder
angefordert noch geloggt (`build_buffers_pod` setzt nur `dataType`). Erster
Schritt: `SPA_PARAM_BUFFERS_buffers` als Bereich anfordern und die zugeteilte
Zahl loggen. Zweiter Schritt als Messung: Puffer erst nach dem Import
zurückgeben und schauen, ob sich am Bild etwas ändert. Im ganzen Sidecar gibt
es keine explizite GL-Synchronisation (`glFinish`, `eglClientWaitSync`, …:
null Treffer); ob der NVIDIA-Treiber die implizite dma-buf-Fence auflöst, ist
ungeprüft.

**4.4 Stehende Bilder nicht neu encodieren.** Bei Bildschirmarbeit ist
Stillstand der Normalfall, und dasselbe HW-Bild geht 60-mal je Sekunde durch
NVENC (`stream_controller.rs:1056`). Die Begründung für konstante Bildrate
stammt aus der FLV-Zeit. Risiko: der Vollbild-Abstand zählt in Bildern und
würde sich in Sekunden strecken; Standbild-Timing hat hier schon einmal
gebissen (2026-08-14). Nur mit Gegenmessung an Zuschauer und MediaMTX.

**4.5 FBO-Zustand je Bild.** Zweimal Anhängen plus zweimal
Vollständigkeitsprüfung je Bild, obwohl sich das Ziel nie ändert. Zwei feste
FBOs beim Anlegen des Stagings. Klein, wird mit 4.1 gegenstandslos.

**4.6 Frame-Pool von 4** (`hw.rs:118`). CUDA-Pools wachsen nicht; `last_hw`,
Import und Encoder halten zusammen drei bis vier. Erschöpfung wäre ein
Import-Fehler, der nach zwei Sekunden den Stream beendet. Ob es je eintritt,
ist Vermutung; 8 kostet wenige MB.

**4.7 Import und Encode pipelinen.** Beides liegt seriell auf einem Faden.
Größter struktureller Hebel bei hohen Bildraten, aber EGL- und CUDA-Kontext
sind fadengebunden. Erst sinnvoll, wenn die Budget-Aufteilung gemessen ist;
4.2 nimmt einen Teil vorweg.

**Nicht anfassen:** Ein-Slot-Postfach, Nachfrist von einer halben Bildlänge,
EGLImage-Cache, Encoder-Optionen, Muxer-Weg.

## 5. Kann man 10 bit unter Linux sehen? Unter KDE ja, unter niri hier nicht

**KDE (Messung 2026-07-26, dieselbe Maschine):** Link 10 bpc, KWin komponiert
in AB30/AB4H, mpv reicht ein 10-bit-Testbild durch. Der native Player fordert
als Fensterformat zuerst `Rgb10a2Unorm` an (`setup.rs:32`), hält P010 in
16-bit-Texturen, und die Messung vom 2026-08-04 belegt am zurückgelesenen
Bildpunkt, dass nichts unterwegs gekappt wird. **Chromium und damit Electron
kappen auf 8 bit** (AB24-Puffer in jeder Konfiguration, auch mit HDR). KWins
ScreenCast gibt dagegen selbst mit 10-bit-Angebot nur XR24 heraus (Messung
2026-08-04, AMD/Mesa).

**niri 26.04, gemessen am 2026-09-08 in der laufenden Sitzung:**

| Stelle | Befund |
|---|---|
| DisplayPort-Link, beide Monitore (`output_bpc`) | Maximum 10 bpc |
| Scanout-Ebenen (`/sys/kernel/debug/dri/1/state`) | alle XR24, also **8 bit** |
| niri-ScreenCast (Journal, 17:54) | ausgehandelt `BGRx`, 8 bit |

niri versucht laut Doku standardmäßig 10-bit-Ausgabe und fällt sonst auf 8 bit
zurück (Debug-Option `disable-10bit-output`); es gibt keine Option, 10 bit zu
erzwingen, und keine Konfiguration für die Bittiefe (Issue 1533). Auf dieser
Karte ist es beim Rückfall gelandet. **Vermutung** zur Ursache: der
NVIDIA-Treiber bietet XRGB2101010 nicht an, nur XBGR2101010; im niri-Log steht
keine Zeile dazu.

**Der Unterschied zu KDE, der für Pulse zählt:** niri gibt im ScreenCast alle
Formate heraus, in denen es rendert, auch 10-bit-Formate, sobald der Output in
10 bit läuft (Issue 3145 — GStreamer-Programme scheitern genau daran). Sollte
niri auf NVIDIA je in 10 bit ausgeben, brächte `PULSE_CAPTURE_10BIT=1`
zusammen mit dem Shader-Weg in `nv_p010.rs` **echte** 10-bit-Bilder in den
Encoder; der Shader sampelt die Quelltextur als normalisierte Fließkommawerte
und trägt ein importiertes `XB30` unverändert (aus dem Code belegt, an
Hardware ungetestet). Der Kommentar an `zehn_bit_aufnahme_gewuenscht`
behauptete bis heute das Gegenteil und ist korrigiert.

Folge: heute sieht man 10 bit auf dieser Maschine nur unter KDE und nur im
nativen Player. Der Nutzen des 10-bit-Encodes (keine Kompressionsstufen in
Verläufen, `2026-07-26-hq-10bit-befund.md`) kommt trotzdem bei jedem
Zuschauer an, auch bei 8-bit-Anzeige.

Quellen außerhalb des Repos: niri-Doku Debug-Optionen
(<https://niri-wm.github.io/niri/Configuration:-Debug-Options.html>), niri
Issue 1533 (<https://github.com/niri-wm/niri/issues/1533>), niri Issue 3145
(<https://github.com/YaLTeR/niri/issues/3145>), niri Discussion 2685 zum
Stand von HDR (<https://github.com/niri-wm/niri/discussions/2685>).

## 6. Vorgeschlagene Reihenfolge

1. 4.1 messen: ein Lauf in 8 bit mit `PULSE_ENCODER_OPTS=highbitdepth=1`,
   Bittiefe am Server abgreifen, Rest-Test, Testbild gegen den Shader-Weg.
   Trägt es, werden 4.5 und die Hälfte von 4.2 gegenstandslos.
2. 4.3: Puffermenge anfordern und loggen, dann den Rückgabe-Zeitpunkt als
   Messung verschieben.
3. 4.2 als Messreihe mit Rückschalter.
4. Für niri: `PULSE_CAPTURE_10BIT=1` einmal laufen lassen, sobald die
   Scanout-Ebenen etwas anderes als XR24 zeigen.
