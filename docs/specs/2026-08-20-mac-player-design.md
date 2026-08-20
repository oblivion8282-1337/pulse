# Der native Player auf macOS — Entwurf (2026-08-20)

Ziel: `streaming/pulse-player/` läuft auf macOS, nutzt die Hardware zum
Dekodieren und wird mit dem DMG ausgeliefert. Danach ist der Mac beim Zusehen
gleichauf mit Windows und Linux.

Schwesterentwurf, gleichzeitig in Arbeit auf einem eigenen Zweig:
`2026-08-20-mac-whip-sender-design.md` (die Senderichtung). Beide berühren am
Ende nur eine gemeinsame Datei — `desktop/package.json` (Version) — sonst
nichts.

## Ausgangslage

Der Player wird auf macOS heute **gar nicht gebaut und nicht ausgeliefert**.

- `.github/workflows/mac-build.yml` hat `streaming/pulse-player/**` nicht im
  Pfad-Trigger (Z. 28–34); gebaut wird nur der Sidecar.
- `desktop/electron-builder.yml` listet unter `mac.extraResources` (Z. 180–210)
  nur `hq-sidecar` — kein `pulse-player`.
- Folge: `resolvePlayerBinary()` (`desktop/electron/player.ts:83-156`) findet
  nichts, `player:available` meldet `false`, und die Mac-App fällt still auf den
  `<video>`-WHEP-Weg zurück. Das ist ein vorgesehener Zustand, kein Fehler.

### Was am 2026-08-20 neu gemessen wurde

`streaming/pulse-player/README.md` sagt an zwei Stellen (Z. 247–254, Z. 662–665)
„macOS bleibt ungeprueft". **Das gilt nicht mehr.** Auf diesem Mac (arm64,
macOS 15.7.3, rustc 1.96, Homebrew-FFmpeg 8.0.1) läuft

    cargo check   →   Finished in 36,68 s, exit 0

sauber durch; es bleiben vier Warnungen, alle Dead-Code (`render/fremdbild.rs`
Z. 185/296, `render/abdruck.rs` Z. 90/195). Der plattformneutrale Kern trägt
also bereits: WHEP, Jitter, Depacketizer, FlexFEC, wgpu (wählt auf macOS über
`Backends::all()` von selbst Metal), winit, egui, cpal (CoreAudio), das
gevendorte webrtc-rs, rustls.

Der Player hat **keinen einzigen** `target_os = "macos"`-Zweig — aber auch
keinen für Windows (dort `cfg(windows)`), und nur 22 für Linux. Plattformarbeit
steckt fast ausschliesslich im Zero-Copy-Pfad. macOS existiert heute nur als
`not(any(windows, linux))`-Restfall.

Die README-Aussage wird mit diesem Vorhaben berichtigt — sie steht an zwei
Stellen und beide werden gezogen.

## Was fehlt

1. **Hardware-Decode.** `Hwaccel` (`src/decode.rs:92-106`) kennt `Vaapi`,
   `D3d11va`, `Cuda` — kein VideoToolbox. Auf macOS liefe der Player heute rein
   in Software (`libdav1d` / `h264`).
2. **Bündelweg.** Ein auslieferbares Binary braucht das LGPL-FFmpeg neben sich.
3. **CI und Packaging.** Siehe Ausgangslage.
4. Nachrangig: EDR/HDR-Ausgang und IOSurface-Zero-Copy (Stufen A4/A5 unten).

## Aufbau in Stufen

Die Stufen A1–A3 sind **zusammen auslieferbar** und werden von A4/A5 nicht
aufgehalten. Das ist eine ausdrückliche Festlegung, kein Zufall der Reihenfolge.

Die Begründung liefert die Windows-Erfahrung mit Zero-Copy — allerdings anders,
als es das Player-README nahelegt (dazu unten „Was danach zu berichtigen ist").
Dort wird Zero-Copy auf NVIDIA als „nie erreicht" geführt; das galt nur bis zum
2026-08-11 vormittags und ist seither behoben (`ZUERST_NATIV_HW`,
`src/decode.rs:511`). Der Weg funktioniert dort inzwischen und ist gemessen.

Lehrreich ist der **Verlauf**: die Kostenseite lag am 2026-08-11 früh vor
(Hochladen 1,20 → 0,00 ms bei 1080p8), und trotzdem wurde die Vorgabe zunächst
ausdrücklich **nicht** umgestellt — es fehlte der Beleg auf der Robustheitsseite
(Verhalten nach Paketverlust, Wiederaufsetzen, Einstieg in einen
Intra-Refresh-Strom), und `decode.rs` führte für cuvid mehrere hart erarbeitete
Sonderbehandlungen, die für D3D11VA niemand geprüft hatte. Erst als
`player-2026-08-11-robustheit-d3d11va-gegen-cuvid.json` nachgereicht war, wurde
gedreht.

Daraus folgt für macOS: eine Zero-Copy-Brücke braucht **zwei** getrennte Belege,
und der zweite ist der teurere. Das ist ein eigener Arbeitszyklus mit eigenem
Messaufwand — kein Anhängsel an eine Auslieferung. Ein Vorhaben, das das DMG
daran hängt, hätte ein offenes Ende.

### A1 — VideoToolbox als hwaccel

`Hwaccel` bekommt eine vierte Variante `VideoToolbox` →
`AV_HWDEVICE_TYPE_VIDEOTOOLBOX`, mit den drei zugehörigen Abbildungen im
selben Muster wie die bestehenden drei (`ffi`-Typ Z. 102–104, Klartextname
Z. 111, `flags` für `av_hwdevice_ctx_create` Z. 116ff).

In der Kandidatenliste (`src/decode.rs:518-578`) steht auf macOS der **native
Decoder mit VideoToolbox-hwaccel** vor Software. Kein neuer Decoder-Name:
`*_videotoolbox` gibt es auf macOS nur encoderseitig — Dekodieren läuft
ausschliesslich über den hwaccel. Genau diese Verwechslung ist in `decode.rs`
Z. 77–79 schon einmal dokumentiert worden; sie wird hier nicht wiederholt.

`PULSE_PLAYER_DECODER` (`src/decoderwahl.rs`) muss den neuen Weg benennen
können, damit sich Hardware und Software für eine Messung gegeneinander
stellen lassen.

Das FFmpeg, gegen das gebaut wird, kann VideoToolbox bereits:
`streaming/mac-hq-sidecar/scripts/build-ffmpeg.sh` Z. 39 setzt
`--enable-videotoolbox`.

**Fertig, wenn:** ein AV1- und ein H.264-Strom auf diesem Mac hardware-dekodiert
ankommen, nachgewiesen über die Decoder-Zeile im Statistik-Overlay, und der
Rückfall auf Software greift, wenn `PULSE_PLAYER_HWDEC=0` gesetzt ist (den
Schalter setzt Electron über `player-hwdec-wacht.ts` bereits selbst).

### A2 — FFmpeg bündeln

Hier zahlt sich Bestehendes aus, es wird nichts Neues erfunden:

- `mac-hq-sidecar/scripts/build-ffmpeg.sh` baut das private LGPL-FFmpeg
  (openssl statt SecureTransport, `--enable-videotoolbox --enable-audiotoolbox
  --enable-libopus`, Prefix `~/src/ffmpeg-openssl`). Der Player nutzt **dasselbe**
  Prefix — kein zweiter FFmpeg-Bau, kein zweiter CI-Cache.
- `mac-hq-sidecar/scripts/bundle-dylibs.sh` ist bereits generisch: Aufruf ist
  `bundle-dylibs.sh <binary> <outdir>`. Er kopiert rekursiv jede Nicht-System-
  Dylib neben das Binary, schreibt die install-names auf `@loader_path` um und
  signiert jede angefasste Datei ad-hoc nach (auf arm64 zwingend —
  `install_name_tool` macht die Signatur ungültig und der Kernel schiesst
  ungültig signierte Binaries ab). Er wird für den Player **unverändert**
  verwendet.
- `streaming/pulse-player/build.rs` bleibt unangetastet: es kehrt ausserhalb
  von Windows früh zurück und verlässt sich auf `pkg-config` und `@rpath` —
  genau das, was hier gebraucht wird.

Zu setzen ist lediglich `PKG_CONFIG_PATH` auf dasselbe Prefix. Anmerkung zum
Zusammenspiel: `mac-hq-sidecar/.cargo/config.toml` trägt einen auf Michaels Mac
fest verdrahteten Pfad; cargos `[env]` ist nicht-erzwingend, die CI überschreibt
ihn (`mac-build.yml` Z. 99–109). Der Player darf sich auf diese Datei nicht
verlassen, weil sie zu einer anderen Crate gehört.

**Offen und in der Umsetzung zu klären:** Der Sidecar und der Player landen
beide in `Resources/hq-sidecar/`. Ob sie sich einen Dylib-Satz teilen oder
jeder seinen eigenen bekommt, entscheidet erst der Blick auf die tatsächlich
gezogenen Bibliotheken — `bundle-dylibs.sh` leert sein Ausgabeverzeichnis
eingangs (`rm -rf "$OUT"`), zweimal nacheinander in dasselbe Verzeichnis
aufgerufen träfe also das zuerst Gebündelte. Das ist der eine Punkt in A2, der
nicht schon gelöst ist.

**Fertig, wenn:** das gebündelte Verzeichnis auf einen Mac ohne Homebrew und
ohne `~/src/ffmpeg-openssl` kopiert werden kann und der Player dort startet.

### A3 — Bauen und ausliefern

- `mac-build.yml`: `streaming/pulse-player/**` in den Pfad-Trigger; Schritt
  `bootstrap-webrtc.sh` (ohne ihn scheitert bereits `cargo resolve` — `vendor/`
  ist gitignored); Player und Sidecar **gleichzeitig** bauen, wie es
  `win-build.yml` Z. 117–155 vormacht; den Cargo-Cache-Workspace (heute nur
  `streaming/mac-hq-sidecar`, Z. 56) um den Player erweitern.
- `electron-builder.yml`: `pulse-player` in `mac.extraResources` →
  `hq-sidecar/`, gleiche Ablage wie unter Windows.
- `desktop/electron/player.ts` **bleibt unverändert.** Zweig 4
  (`process.resourcesPath/hq-sidecar/<BINARY>`, Z. 143–145) greift auf macOS
  bereits; das Verzeichnis ist heute nur leer. `BINARY_NAME` ist ausserhalb von
  Windows schon `pulse-player` (Z. 83).

**Fertig, wenn:** ein CI-DMG auf einem Mac installiert wird, `player:available`
`true` meldet und ein HQ-Stream im nativen Fenster ankommt.

### A4 — EDR/HDR-Ausgang (nachgelagert)

`src/render/hdr_fenster.rs` gibt ausserhalb von Windows heute immer `false`
zurück (`farbraum_anmelden` Z. 121–126); `schirm_ist_hdr` existiert nur unter
`cfg(windows)`. HDR-Material wird auf macOS also heruntergerechnet — über den
bestehenden Reinhard-Weg (BT.2408, 203 cd/m²), es ist kein kaputter, sondern
ein konservativer Zustand.

Anzusprechen wäre `CAMetalLayer` mit EDR. Eigene Stufe, weil sie eine
Apple-eigene Schnittstelle in einen bisher wgpu-neutralen Renderer holt.

### A5 — IOSurface-Zero-Copy (nachgelagert)

`src/zerocopy/leer.rs` ist der **bewusste** Platzhalter für macOS; sein
Kommentar (Z. 1–14) benennt den Grund: VideoToolbox gibt seine Bilder als
`IOSurface` heraus, das wäre eine vierte Brücke, und sie vorzutäuschen wäre
schlimmer als ihr Fehlen. `GpuBild` und `Bruecke` sind dort unbewohnte Enums,
`bruecke_moeglich()` liefert konstant `false`.

„Vierte Brücke" ist wörtlich zu nehmen. Es gibt heute drei, und der Kopf von
`zerocopy/mod.rs` hält fest, dass ihre Unterschiede **erzwungen und nicht
gewählt** sind — bei Windows (geteilte Textur, NT-Handle) und Linux/NVIDIA
(exportiertes `VkImage`) ist sogar die Richtung vertauscht, weil FFmpegs
CUDA-Speicher nicht exportierbar ist, und der VAAPI-Weg kopiert überhaupt
nicht. Eine IOSurface-Brücke erbt von keiner der drei mehr als das Muster.

Diese Stufe ist ausdrücklich ergebnisoffen. Sie wird gemessen, nicht geglaubt —
und zwar zweifach, Kosten und Robustheit getrennt (Begründung oben bei den
Stufen). Ohne einen Nachweis, dass der Umweg über den Hauptspeicher auf dieser
Hardware wirklich weh tut, wird sie gar nicht erst gebaut.

## Was nicht dazugehört

- Die Senderichtung — eigener Entwurf, eigener Zweig.
- Signierung und Notarisierung. Die Mac-App wird bewusst unsigniert
  ausgeliefert (`mac-build.yml` Z. 8–12); daran ändert dieses Vorhaben nichts.
- Auto-Update auf macOS. Gibt es heute nicht, bleibt so.
- Die Fernsteuerung. Der Mac als Steuernder fällt weitgehend mit A ab
  (`src/fernsteuerung/` ist winit-basiert), der Mac als Host ist Neuland
  (Injektion, Bedienungshilfen-Rechte, ein Gegenstück zu WGC). Beides wird
  bewertet, wenn A steht.

## Mitzunehmen

Der wartende Zweig **`build/player-ffmpeg-lokal`** geht hier mit. CLAUDE.md
hält fest, dass er auf die nächste echte Player-Änderung wartet, weil der Pfad
`streaming/pulse-player/**` Windows- und Flatpak-Bau auslöst und ein Neubau
ohne Versionswechsel Bestandsclients gar nicht erreicht. Genau diese Änderung
ist es. Er hat einen Konflikt gegen das Player-README, der beim Landen
aufzulösen ist.

## Prüfen

- `cargo test` im Player (326 Tests, laufen ohne Hardware) und `cargo clippy`.
- Neue Tests dort, wo die Rechnung ohne Hardware prüfbar ist: die Wahl des
  hwaccel je Plattform und die Kandidatenreihenfolge.
- Von Hand, weil nicht automatisierbar: HQ-Stream mit zwei Clients, Sichttest
  am Fenster, Hardware-gegen-Software-Vergleich über
  `PULSE_PLAYER_DECODER`.
- Vor dem Push wie immer: pytest, `pnpm check`, `pnpm build`, Playwright.

## Auslieferung

Der Player fährt auf macOS im DMG mit — **und unter Windows über den
Installer.** Deshalb gilt die Regel aus CLAUDE.md: eine Änderung an
`streaming/pulse-player/**` erreicht Windows-Bestandsclients nur mit einem
Versionswechsel in `desktop/package.json`. Der Bump gehört in diesen Zweig,
auch wenn das Vorhaben „nur" macOS im Titel trägt.

Ein Changelog-Eintrag gehört dazu: Mac-Nutzer bekommen sichtbar ein anderes
Player-Fenster. Stil wird vor dem Push abgestimmt, echte Umlaute, keine Emojis.

## Was danach zu berichtigen ist

Eine Behauptung wird nie an nur einer Stelle korrigiert:

- `streaming/pulse-player/README.md` Z. 247–254 und Z. 662–665 („macOS bleibt
  ungeprueft und wird nicht ausgeliefert", offener Punkt 5).

- **Nebenfund, gehört unabhängig von diesem Vorhaben berichtigt:** dasselbe
  README führt Zero-Copy auf NVIDIA unter Windows als „nie erreicht" (Z. 212–215)
  und widmet dem einen ganzen Blockquote (Z. 265–296, bis hin zu „Wer die
  Vorgabe drehen will, misst das zuerst"). **Das ist überholt.** Der Kopf von
  `src/decode.rs` (Z. 22–42) dokumentiert die Behebung vom 2026-08-11:
  `ZUERST_NATIV_HW` (`decode.rs:511`) stellt unter Windows den nativen Decoder
  mit D3D11VA vor `*_cuvid`, womit der Zero-Copy-Weg für alle drei Hersteller
  gilt; die Robustheitsmessung, deren Fehlen die Umstellung vorher blockierte,
  liegt als `player-2026-08-11-robustheit-d3d11va-gegen-cuvid.json` vor.
  README und Code widersprechen sich hier also — korrigiert wurde nur eine der
  beiden Stellen. Aufgefallen beim Prüfen einer Behauptung, die aus dem
  veralteten README in einen früheren Stand dieses Entwurfs geraten war.
- `streaming/pulse-player/WISSENSSTAND.md` — enthält heute keine macOS-Aussage;
  die Messung aus A1 gehört dort als GEMESSEN hinein.
- `CLAUDE.md`, wo die Auslieferungswege des Players aufgezählt sind.
