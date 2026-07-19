# HQ-Streaming: Lohnt sich ein Qualitäts-/Latenz-Umschalter für H.264?

**Ergebnis: nein.** Gemessen am 2026-07-19. Der maximal erreichbare Qualitätsgewinn
liegt unter der Wahrnehmungsschwelle, kostet aber 40–50 % Encode-Durchsatz.
Empfehlung: Encoder-Einstellungen unangetastet lassen, die Mühe stattdessen in die
**Kopplung von Bitrate an Auflösung** stecken.

Dieses Dokument hält die Messung fest, damit die Frage nicht in einem Jahr erneut
aus dem Bauch heraus aufgerollt wird.

---

## Ausgangsfrage

Die Sidecars sind auf niedrige Latenz getrimmt. Könnte man bei H.264 eine
Qualitätsstufe anbieten — ein Umschalter im HQ-Panel zwischen „reaktionsschnell"
und „bessere Bildqualität"? (AV1 war im ersten Durchgang bewusst ausgeklammert.)

## Ausgangslage im Code

Die fünf Encoder-Pfade waren unterschiedlich weit eingestellt — nur einer von fünf
ist wirklich auf Anschlag getrimmt:

| Pfad | gesetzt |
|---|---|
| Windows/NVENC | `tune=ull`, `preset=p2`, `zerolatency=1`, `delay=0` |
| Linux/NVENC | `tune=ll`, **kein preset** (→ ffmpeg-Default p4) |
| Linux/VAAPI | `rc_mode=CBR`, `async_depth=3` |
| Windows/AMD (D3D12VA) | nur `rc_mode=CBR` |
| macOS/VideoToolbox | nur `realtime=true` |

Plattformübergreifend **nicht** gesetzt: VBV-/Rate-Control-Puffer (überall nur
`bit_rate == max_bit_rate`), adaptive Quantisierung, Lookahead. B-Frames aus,
GOP 2 s.

Ein Kommentar in `opts.rs` behauptete, `preset`/Multipass/Lookahead wirkten nur
mit `tune=quality`. **Das ist widerlegt** (siehe unten) und inzwischen im Code
korrigiert.

## Messaufbau

- Hardware: RTX 4090, `h264_nvenc` über ffmpeg
- Verfahren: dieselbe verlustfreie Quelle mit verschiedenen Einstellungen bei
  **identischer Bitrate** encodiert, jedes Ergebnis gegen das Original gemessen
- Metrik: VMAF (Modell `vmaf_v0.6.1`), zusätzlich Bitstrom-Prüfsummen und
  Encode-Durchsatz
- Material: vier Sorten, um nicht auf einen Sonderfall hereinzufallen

**Wichtige Einschränkung:** VMAF ist auf Film-/Fernsehmaterial trainiert, nicht
auf Bildschirminhalte. Die Zahlen sind ein starker Hinweis, kein Urteil.

### Getestete Varianten

| Kürzel | Einstellungen |
|---|---|
| A | heutiger Stand: `tune=ll`, `rc=cbr`, `bf=0`, `b_ref_mode=0` |
| B | `tune=hq`, `preset=p6`, `multipass=qres`, `spatial-aq=1`, `aq-strength=8` |
| C | wie B, aber **`tune=ll` beibehalten** |
| D | nur `spatial-aq` zusätzlich zu A |
| G | `tune=hq`, p6, multipass, AQ, **`bf=3`, `b_ref_mode=middle`** |
| H | `tune=hq`, p6, multipass, AQ, **`rc-lookahead=30`** |
| I | alles: `p7`, `multipass=fullres`, `spatial-aq`, `temporal-aq`, `bf=3`, `rc-lookahead=30` |
| J | wie G+H, aber `rc=vbr` mit `bufsize=8000k` |

## Ergebnisse

### Synthetisches Material (Kontrollgruppe)

| Material | A | beste Variante | Differenz |
|---|---|---|---|
| `testsrc2` (hochfrequent, Encoder verhungert) | 70,47 | 70,69 (C) | +0,22 |
| Desktop-artig (ruhig, viel Fläche + Text) | 93,91 | 93,91 (B/C) | 0,00 |

Beide Extreme zeigen nichts — einmal weil die Bitrate der Engpass ist, einmal
weil bei VMAF 94 nichts mehr zu holen ist.

### Echtes Bildschirmmaterial

Quelle: 10 s aus einer 1080p60-OBS-Aufnahme (~20 Mbit/s, damit als Referenz
praktisch verlustfrei).

**Bei 4000 kbps** (dem UI-Default):

| Variante | VMAF | gegenüber heute | Latenzkosten |
|---|---|---|---|
| A (heute) | 86,20 | — | — |
| C (p6 + Multipass + AQ, `tune=ll` bleibt) | 87,05 | +0,85 | **keine** |
| B (dasselbe mit `tune=hq`) | 87,19 | +0,99 | keine |
| H (+ Lookahead 30) | 87,09 | +0,89 | ~500 ms |
| G (+ B-Frames statt Lookahead) | 87,74 | +1,54 | Umsortierung |
| J (VBR + VBV-Puffer + B-Frames + Lookahead) | 87,77 | +1,57 | ~500 ms + Umsortierung |
| **I (alles an)** | **88,04** | **+1,84** | ~500 ms + Umsortierung |

**Bei 2000 kbps:** A 81,11 · C 81,03 · B 81,00 — der Gewinn ist **exakt null**
(bzw. minimal negativ, im Rauschen). Bei knapper Bitrate ist der Encoder
bitratenbegrenzt, da hilft kein Tuning.

### Encode-Durchsatz (1080p60, 600 Bilder, RTX 4090)

| Variante | Dauer | fps | Faktor Echtzeit |
|---|---|---|---|
| A | 1,30 s | 460 | 7,7× |
| C | 2,04 s | 294 | 4,9× |
| I | 2,62 s | 229 | 3,8× |

## Was daraus folgt

**1. Die Obergrenze liegt bei +1,84 VMAF.** Unterhalb von etwa sechs Punkten
sieht ein Mensch im direkten Nebeneinander typischerweise nichts; ein bis zwei
Punkte sind für das Auge Rauschen. Ein Umschalter, dessen bessere Seite man nicht
sehen kann, ist eine Attrappe — genau die Sorte Funktion, die mit dem
Profil-Katalog gerade ausgebaut wurde.

**2. Lookahead ist ein schlechtes Geschäft.** 30 Bilder Vorausschau kosten eine
halbe Sekunde Verzögerung und bringen +0,89. B-Frames bringen fast das Doppelte
ohne diesen Preis. Nach Bauchgefühl wäre Lookahead vermutlich in einen
Qualitätsmodus gewandert.

**3. Der Durchsatz ist die eigentliche Grenze.** Bei 1080p60 bleibt auf einer 4090
reichlich Luft. 4K hat aber die vierfache Pixelzahl — hochgerechnet läge Variante I
dort **unter Echtzeit**, könnte also nicht mehr mithalten. Auf schwächeren Karten
gilt das früher. Ein Qualitätsmodus, der bei 4K das Bild abreißen lässt, wäre
schlimmer als keiner.

**4. Der Kommentar in `opts.rs` war falsch.** `preset`/`multipass`/`spatial-aq`
werden auch mit `tune=ll` angenommen und verändern den Bitstrom nachweislich
(verschiedene Prüfsummen, keine „ignoring"-Warnung von ffmpeg). Sie sind also
nicht wirkungslos, sondern nur zu schwach, um sie zu nutzen. Der Kommentar ist im
Linux-Sidecar korrigiert.

## Empfehlung

- **Encoder-Einstellungen unangetastet lassen.** Kein Umschalter, auch nicht
  Variante C als neuer Standard (0,85 unsichtbare Punkte gegen 55 % mehr GPU-Last
  und das 4K-Risiko ist kein guter Tausch).
- **Stattdessen: Bitrate an Auflösung koppeln.** Wer 4K wählt und den Regler nicht
  anfasst, streamt mit 4 Mbit/s. Das sind keine Punkte auf einer Skala, sondern
  ein Bild, das bei Bewegung zusammenbricht. Derselbe Bauaufwand, sichtbares
  Ergebnis.
- Die harte Obergrenze von 10 Mbit/s (`web/src/lib/stream/settings.svelte.ts`)
  stammt aus dem VPS-Uplink (WHEP-Fanout), nicht aus dem Encoder. Weil diese Decke
  fest ist, bleibt **AV1** der einzige Hebel für mehr Qualität ohne mehr Bandbreite
  — das war im ersten Durchgang bewusst ausgeklammert und wäre der nächste Schritt,
  falls das Thema wieder aufgemacht wird.

## Was nicht gemessen wurde

- **Echte Ende-zu-Ende-Latenz** über MediaMTX/WHEP. Bewusst nicht: für den
  *Vergleich* zweier Modi kürzt sich der Netz-/Server-/Pufferanteil weg, und es gab
  am Ende keinen Modus, dessen Latenz zu messen sich gelohnt hätte. Der Zugang zur
  Hetzner-Testinstanz ist vorbereitet (MediaMTX dort mit `authMethod: http`,
  Publish-Token als Passwort im Stream-Key, einmalig).
- **VAAPI (AMD/Intel)**, nur der NVENC-Pfad. Interessante Optionen dort wären
  `quality`, `blbrc` (das AQ-Gegenstück) und `QVBR` als Rate-Control-Modus.
- **Mehr als ein Clip.** Zehn Sekunden, ein Inhaltstyp. Die Richtung ist über vier
  Materialsorten und zwei Bitraten konsistent, aber ein endgültiges Urteil bräuchte
  mehr Material.

Ein Durchgang wurde **verworfen**: Mandelbrot-Material lieferte VMAF um 5 mit
Tiefstwert 0 — bei diesem Bildinhalt ist die Messung degeneriert, das ist kein
Ergebnis, sondern ein kaputter Vergleich.
