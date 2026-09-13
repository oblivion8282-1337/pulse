# Windows/AMD: HEVC über AMF — 10-bit-Erstbetriebnahme (2026-09-13)

Windows-Gegenstück zu `2026-09-13-amd-780m-hevc.md` (dort Linux/VAAPI, E2E).
Maschine: Radeon 780M (Phoenix, VCN4, iGPU), Windows 11, gepatchtes
LGPL-FFmpeg n8.1 aus `win-hq-sidecar/ffmpeg-dist/n8.1-lgpl-shared/` — dieselbe
Konstellation, gegen die der Sidecar linkt. Der `hevc`-Branch hatte den
Windows-Sender weitgehend schon mitgebracht (`VideoCodec::Hevc` mit
`hevc_amf`, Caps-Meldung); offen waren der WHIP-Paketierer, das 10-bit-Gate
und die Fähigkeitsmeldung — alles in dieser Sitzung geschlossen.

## Messung (Encoder-Optionen der Produktion)

Direkt gegen den gebündelten FFmpeg-Binary, Optionsliste exakt wie
`encode::opts` sie beim 10-bit-Start setzt (`usage=ultralowlatency, rc=cbr,
forced_idr=1, bitdepth=10, profile=main10`, P010-Eingang 1280×720@60,
20 Mbit/s CBR, 30 Bilder, Rampe mit echten 10-bit-Zwischenwerten):

| Lauf | Bitstrom | Werte jenseits 8-bit-Stufen |
|---|---|---|
| `hevc_amf` + `bitdepth=10` + `profile=main10` | `profile=Main 10`, `yuv420p10le` | **50,1 %** |
| `hevc_amf` + P010 **ohne** Optionen | `profile=Main 10` (Bittiefe folgt dem Eingang) | 50,1 % |
| `hevc_amf` + NV12 (8-bit-Regelweg) | `profile=Main`, `yuv420p` | — |

Die Auswertung liest die dekodierten Luma-Wörter aus (P010 hält 10 Bit
linksbündig; geprüft wird Bit 6–7 des 16-Bit-Worts, d. h. alles, was ein
8-bit-Strom nicht darstellen kann). Das Eingangsmuster trägt konstruktiv
~50 % Zwischenstufen — sie kommen an. Ein 8-bit-Strom unter 10-bit-Etikett
zeige 0 % (vgl. Rest-0-Methode aus der AV1-Akte
`2026-08-11-windows-zehnbit`).

**Belegte Kette:** AMF-Open mit den Produktionsoptionen gelingt auf diesem
Treiber, der Bitstrom trägt Main 10, und die Bittiefe überlebt den Encoder.
Der D3D11-Zero-Copy-Teil (P010-Pool → `hevc_amf`) ist codec-unabhängig und
am 2026-08-01 über `av1_amf` auf derselben Maschine belegt; die Wire-Seite
(HEVC-Paketierer im WHIP-/Direkt-Sender, SDP `profile-id=1`) ist die vom
Linux-E2E gemessene.

## Code-Änderungen dieser Sitzung

* `encode/codec.rs` — `supports_ten_bit` lässt HEVC durch (inkl. Messakte);
  `VideoCodec` bekommt `PartialEq` für die Fähigkeits-Weiche.
* `encode/opts.rs` — AMD-Zweig setzt für HEVC `profile=main10` (FFmpeg legt
  sonst Main vor; 10 bit unter Main ist keine gültige HEVC-Kombination);
  der veraltete Satz „nur `av1_amf` kennt `bitdepth`" ist raus.
* `encode/zehnbit.rs` — Fähigkeitsfrage je Codec (`verfuegbar` = AV1,
  `verfuegbar_hevc` = HEVC), die Antworten fallen nicht mehr aufeinander
  zurück; Tests.
* `ops/health.rs` — meldet `hevc_ten_bit` wie das Linux-Gegenstück; die UI
  (`state.svelte.ts`) liest das Feld seit dem hevc-Branch.
* `whip/mod.rs` — HEVC-Paketierer (`HevcPayloader` + `hevc_ist_vollbild`)
  und der gemeinsame Annex-B-Zerleger, Form wie im Linux-Sidecar.
* `pulse-whip/src/direct` — **Der Direktpfad hatte HEVC gefehlt** (die
  Linux-Messung lief über WHIP): `Paketierer::Hevc` in `spur.rs`, Auswahl
  und `send` auf denselben Zerleger wie der WHIP-Sender. Ohne diesen Griff
  hätte ein HEVC-Stream über den P2P-Weg still den H.264-Zerleger gefüttert.

## Player-Seite (Windows)

Der Player wählt HEVC über die generische Kandidatenliste — unter Windows
gewinnt der native Decoder mit D3D11VA (`ZUERST_NATIV_HW`), für 8 und
10 bit; die D3D11-Zero-Copy-Brücke ist Pixelformat-getrieben (NV12/P010) und
am 2026-08-11 über den RTX-5080-Lauf belegt. Ein Live-E2E auf dieser
Maschine (Sender + Zuschauer auf Windows) steht noch aus — der Dev-Stack
lief nicht. Wer ihn nachholt: `testbench/real-harness.py --codec hevc`
(Windows-Pendant `win-hq-labor`), 8 und 10 bit, und im Player-Protokoll
`Decoder hevc (Hardware (D3D11VA))` samt „Zero-Copy an" erwarten.

## Grenzen

- Nur der Regelweg AMF/D3D11 (780M iGPU); `PULSE_HQ_AMD_D3D12`-Weg bleibt
  NV12-only, CPU-Weg ohne 10 bit — beide weigern den Start ehrlich
  (`zehnbit::pruefen`).
- HEVC-NVIDIA-Windows ist unangetastet und strukturbelegt: NVIDIA bleibt in
  der Codec-Probe (öffnet `hevc_nvenc` zur Laufzeit), 10 bit folgt dem
  P010-Pool — `nvenc_setup_hevc_config()` erzwingt Main10 bei 10-Bit-Eingang
  ohne jede Option (FFmpeg n8.1 verifiziert) und scheitert laut, wenn die
  Karte es nicht kann. Was fehlt, ist der E2E-Lauf auf einer echten
  Windows-NVIDIA-Maschine (hier läuft AMD); auf Linux ist HEVC/NVIDIA E2E
  gemessen (RTX 4090).
- HEVC-HDR bleibt bewusst zu (`hdr::traegt_hdr` hat für `hevc_amf`/
  `hevc_nvenc` ein hartes Nein, bis die PQ/BT.2020-Signalisierung gemessen
  ist).
