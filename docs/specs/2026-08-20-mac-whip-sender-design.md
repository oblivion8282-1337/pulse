# Ein eigener WHIP-Sender für macOS — Entwurf (2026-08-20)

Ziel: der mac-Sidecar sendet über einen eigenen WebRTC-Sendeweg statt über
ffmpegs WHIP-Muxer. Damit fallen beide macOS-Sonderfälle auf einmal weg — der
Vollbild-Abstand von 2 s und die AV1-Sperre.

Schwesterentwurf, gleichzeitig in Arbeit auf einem eigenen Zweig:
`2026-08-20-mac-player-design.md` (die Empfangsrichtung). Gemeinsame Datei am
Ende nur `desktop/package.json` (Version).

## Warum

Seit dem 2026-08-18 liefert `pushProtokoll` immer WHIP. Auf macOS geht
`http(s)://` aber an ffmpegs WHIP-Muxer (`mac-hq-sidecar/src/encode/mod.rs`
Z. 133–144, `url_format_hint` → `Some("whip")`), und der kann zwei Dinge nicht:

1. **Keinen Rückkanal zur Anwendung.** Die Vollbild-Anforderung eines
   Zuschauers (RTCP PLI/FIR) erreicht den Encoder nie. Am 2026-07-28 gemessen:
   ohne sie steht das Bild nach einem Paketverlust bis zum nächsten regulären
   Vollbild — bei 0,2 % Verlust in 7 bis 9 von 17 Sekunden. Mit ihr sind es 0
   bis 1, und die Bildrate geht von 0 auf 60.
2. **Kein AV1.** In ffmpeg 8.1 und im aktuellen master trägt `whip.c`
   ausschliesslich H.264.

Daraus folgen die beiden Einschränkungen, die am 2026-08-19 ehrlich gemacht
statt versteckt wurden:

- Der **Vollbild-Abstand bleibt auf macOS bei 2 s**
  (`KEYFRAME_SEKUNDEN_UNBEDENKLICH`, `encode/mod.rs:36`), während Linux und
  Windows auf 60 s stehen. Mit 60 s ohne Anforderungspfad wartete ein
  beitretender Zuschauer bis zu 60 s auf sein erstes Bild — und der native
  Player gibt nach 20 s auf (`MAX_WARTEZEIT_OHNE_KEYFRAME`,
  `pulse-player/src/decode.rs:289`).
- Die **Oberfläche bietet auf macOS kein AV1 mehr an**
  (`web/src/lib/stream/settings.svelte.ts:156-158`, `av1Nutzbar`), weil der
  Muxer es still auf H.264 zurückgenommen hätte.

Der Code benennt die Auflösung an beiden Stellen selbst. In
`settings.svelte.ts` Z. 153–154 steht wörtlich: *„Wer hier je das `!isMac()`
entfernt, baut vorher den eigenen WHIP-Sender für macOS."* Das ist dieses
Vorhaben.

Es ist zugleich der Punkt, an dem die Regel „periodische Vollbilder primär,
Intra-Refresh nur sekundär" auch auf macOS ankommt. Auf Linux und Windows gilt
sie längst; der Mac hängt als einziger bei 2 s fest, und zwar allein mangels
Rückkanal.

## Der Befund, der den Zuschnitt bestimmt

`streaming/win-hq-sidecar/src/whip/` ist **vollständig plattformneutral.** Kein
einziges `cfg(windows)`, keine Windows-API, keine `windows::`-Verwendung. Die
externen Abhängigkeiten sind `anyhow`, `bytes`, `rtcp`, `tokio`, `webrtc`.

Das Vorhaben ist deshalb keine Portierung, sondern eine **Extraktion**. Der
Code muss nicht übersetzt, sondern geteilt werden.

## Aufbau

### C1 — Neue Crate `streaming/pulse-whip/`

Bisher steht im Repo jede Sidecar-Crate für sich; es gibt keinen Workspace und
keine geteilten Crates. Geteilter Code wurde bislang als **Zwilling mit
Wortgleichheits-Test** gelöst (`zeigerbild.rs` mit `pulse-player/tests/
zwillinge.rs`, dazu `zeitbasis.rs`). Für dieses Stück trägt das Muster nicht
mehr: es sind 2.225 Zeilen mit echter Logik — Taktgeber, Bandbreitenschätzer
und ein eigener AV1-Paketierer, der einen dokumentierten Fehler in webrtc-rs'
`Av1Payloader` umgeht (Längenfelder ab 128 falsch geschrieben). Ein Fix daran
müsste sonst jedes Mal zweimal passieren.

#### Der Befund, der C1 grösser macht als gedacht: es gibt schon zwei Fassungen

Ein früherer Stand dieses Entwurfs nahm an, nur Windows habe einen eigenen
WHIP-Sender. Das ist falsch: **`linux-hq-sidecar/src/whip/` existiert ebenfalls**
(1.936 Zeilen, vier Dateien). Der Vergleich beider Fassungen, Kommentare
herausgerechnet:

| Datei | Codezeilen Win / Linux | abweichend | Befund |
|---|---|---|---|
| `av1.rs` | 496 / 496 | **0** | reine Doppelung — einziger Unterschied ist die Position eines Doc-Absatzes |
| `sdp.rs` | 220 / 220 | **0** | bitgleich |
| `mod.rs` | 336 / 278 | 80 | **kein Konflikt, sondern Vorsprung**: die Abweichungen sind fast vollständig Windows-Zusätze — REMB-Bandbreitenschätzung (eigene Datei `bandbreite.rs`, die Linux gar nicht hat), Senken-Registry, Token-Redaktion |
| `pacer.rs` | 103 / 129 | 120 | **zwei echte Algorithmen** |

716 Codezeilen liegen also heute schon doppelt im Repo — ohne Zwillings-Test,
ohne Vermerk. Genau das Muster, das CLAUDE.md beim Paar `zeitbasis.rs`
beschreibt: still auseinandergelaufen, harmlos nur durch Glück.

#### Der Pacer wird umgangen, nicht gelöst

Beide Taktgeber wurden am 2026-08-14 von der gescheiterten Erstfassung weg
umgebaut, aber in verschiedene Richtungen: **Windows** teilt das Sendefenster
durch die Gruppenzahl (variabler Abstand, Untergrenze `MIN_ABSTAND = 2 ms`,
`zuschnitt()`), **Linux** hält einen festen `GRUPPEN_ABSTAND = 2500 µs` und
variiert die Gruppenzahl (`gruppenzahl()`). Dazu prüft Windows in der
Eilig-Bedingung zusätzlich `remote_input::fern_aktiv()` — ein echtes Feature,
das Linux nicht braucht, weil dort niemand Host ist.

Welcher Algorithmus besser ist, **ist nicht entschieden und wird hier nicht
entschieden.** Eine Antwort verlangte eine Messung über eine echte Strecke
(lokal treten die Ankunftslücken gar nicht auf — 0 bei 4000 kbps), und der
Messstand ist gestoppt.

Deshalb: **`pacer.rs` bleibt plattformeigen**, hinter einem schmalen Trait in
der Crate. Beide Algorithmen laufen weiter dort, wo sie sich bewährt haben. Das
kostet nichts, weil die Schnittstelle bereits deckungsgleich ist — beide
`mod.rs` konstruieren wortgleich
`Pacer::start(runtime(), Arc::clone(&video_track), frame_duration)`, halten
wortgleich `pacer: Option<pacer::Pacer>` und rufen wortgleich `p.send(pakete)`.

Ein angenehmer Nebeneffekt: bleibt der Pacer plattformeigen, bleibt
`fern_aktiv()` in ihm — und ist gar kein Callback mehr. Es bleiben **zwei**
Nähte statt drei.

#### Was Linux dabei dazubekommt

Wandert `mod.rs` in die Crate, erbt der Linux-Sidecar die
REMB-Bandbreitenschätzung, die er heute nicht hat. Das ist inhaltlich eine
Verbesserung, aber **eine Verhaltensänderung an produktivem Code** — sie gehört
als solche ausgewiesen und einzeln geprüft, nicht als stille Nebenwirkung einer
Extraktion.

Die Anbindung nach aussen ist schmal: `whip::senke::baue` wird in
`win-hq-sidecar/src/main.rs:64-66` als Funktionszeiger übergeben, dazu kommen
der Typ `SendewegAbgewiesen` (`encode/bildencoder.rs:327`, ein
`pub struct SendewegAbgewiesen(pub u16)` — der HTTP-Status, **bewusst ohne die
URL**, weil dort das Token steht) und `av1::RTP_TAKT_HZ` (`zeitbasis.rs:32`).

Eine Randbedingung, die früh zu klären ist: `win-hq-sidecar` zieht das
unveränderte `webrtc` 0.17 von crates.io, während `pulse-player` es vendort und
mit drei Patches versieht. `[patch.crates-io]` wirkt nur im jeweiligen
Workspace-Root, die beiden sind heute also getrennt. Für den reinen Sendeweg
bringt der Player-Patch nichts — `pulse-whip` bleibt beim unveränderten
`webrtc`.

Nach innen greift `whip/` sechsmal in die Sidecar-Crate zurück. Die Extraktion
löst sie so auf:

| Rückgriff | Auflösung |
|---|---|
| `crate::encode::senke::{PaketSenke, SenkenAuftrag}` (`senke.rs:20`) | **bleibt im Sidecar** — s. unten, das ist die wichtigste Erkenntnis der Inventur |
| `crate::zeitbasis::takte_je_bild` (`av1.rs:414`) | **wandert mit** — eine Zeile Ceil-Division; die beiden anderen (`VIDEO_HZ`, `pts_aus_sekunden`) werden nur im Testmodul gebraucht |
| `crate::redact::secrets` (`mod.rs:441`) | **wandert mit.** Tokens dürfen nie geloggt werden; die Redaktion gehört an den Code, der die URL kennt. `redact.rs:42-44` verbietet ausdrücklich zwei Fassungen |
| `crate::keyframe::request_keyframe` (`mod.rs:392`) | **Callback** `Arc<dyn Fn() + Send + Sync>`, beim Aufbau gestellt |
| `crate::events::emit` (`mod.rs:239`) | **Callback** |
| `crate::remote_input::fern_aktiv` (`pacer.rs:149`) | **`Arc<AtomicBool>`**, an `Pacer::start` durchgereicht |

**Die Korrektur am ursprünglichen Zuschnitt.** Ein früherer Stand dieses
Entwurfs ließ `PaketSenke`/`SenkenAuftrag` mitwandern. Das geht nicht:
`whip/senke.rs` ist die **einzige** Datei in `whip/`, die in die Sidecar-Crate
zurückgreift, und mitgewandert entstünde eine zirkuläre Abhängigkeit
`pulse-whip` → `win-hq-sidecar`.

Richtig ist der umgekehrte Schnitt: `pulse-whip` kennt nur seinen eigenen
`WhipSender` (`connect`/`send`/`send_audio`/`close`), und **jeder Sidecar
schreibt seinen eigenen dünnen Adapter** auf sein `PaketSenke`-Trait. Unter
Windows ist dieser Adapter das heutige `senke.rs` — 30 Zeilen, die bleiben, wo
sie sind. Der mac-Sidecar bekommt sein Gegenstück.

Das ist nicht nur zulässig, sondern besser: die Crate weiß dann nichts über die
Senken-Abstraktion irgendeines Sidecars, und beide Seiten können ihre eigene
behalten.

**Der Einhängepunkt existiert bereits.** `encode/senke.rs:104-112` führt
`pub type SenkenBauer = fn(&SenkenAuftrag) -> Result<Box<dyn PaketSenke>>` und
`registriere_senken_bauer()`; `main.rs:64-66` meldet dort den Funktionszeiger
an. Ein Test (`ohne_anmeldung_geht_alles_ueber_den_muxer`) hält fest, dass die
Anmeldung im Binary steht und nicht in `lib.rs`. Der mac-Sidecar kann dasselbe
Muster übernehmen, statt eines zu erfinden.

Für den Windows-Sidecar ist das Ergebnis **verhaltensgleich**: `whip/` wandert
bis auf `senke.rs` aus, und es entstehen drei Einhängungen. Keine geänderte
Logik.

Nachzuziehen sind die Bauwege — die Flatpak-Manifeste rechnen mit
selbsttragenden Crates (`packaging/*-cargo-sources.json`, Cargo baut dort
offline), Windows- und Mac-CI cachen je Crate-Verzeichnis.

**Fertig, wenn:** der Windows-Sidecar mit der Crate gebaut unverändert
funktioniert — `cargo test` grün, ein Stream läuft, ein PLI löst nachweislich
ein Vollbild aus.

### C2 — Der mac-Sidecar sendet selbst

`url_format_hint` (`mac-hq-sidecar/src/encode/mod.rs:133-144`) gibt für
`http(s)://` nicht mehr `Some("whip")` an ffmpegs Muxer, sondern geht über
`pulse-whip`. RTMPS bleibt unverändert beim Muxer — dieselbe Aufteilung wie
unter Windows.

Neu zu bauen ist der **Vollbild-Anforderungspfad**: der mac-Sidecar hat heute
kein `request_keyframe` und kein `pict_type=I`. Beim Windows-Sidecar liegt das
in `keyframe.rs:148`; für VideoToolbox ist das Gegenstück zu finden.

**Fertig, wenn:** ein PLI von einem beitretenden Zuschauer auf macOS
nachweislich ein Vollbild auslöst, und AV1 über den eigenen Weg ankommt statt
still auf H.264 zurückgenommen zu werden.

### C3 — Die Sonderfälle zurücknehmen

Erst wenn C2 nachgewiesen ist, und dann **zusammen** — es sind mehrere Stellen,
die dieselbe Behauptung tragen:

- `KEYFRAME_SEKUNDEN_UNBEDENKLICH` als Vorgabe (`encode/mod.rs:36`, Rechnung
  Z. 76–95) → die regulären 60 s wie Linux und Windows. Die Konstante selbst
  bleibt: sie trägt weiterhin die Bremse für angeforderte Vollbilder und die
  Warnschwelle, und genau diese zwei Zahlen dürfen der Vorgabe nicht folgen.
- `warne_bei_langem_abstand_ohne_rueckkanal()` (`encode/mod.rs:103-113`) →
  entfällt oder wird zur Prüfung, dass der Rückkanal wirklich steht.
- Der Test `ohne_rueckkanal_gilt_der_unbedenkliche_abstand`
  (`encode/mod.rs:393-433`) sichert heute genau das ab, was hier wegfällt — er
  wird ersetzt, nicht gelöscht: die neue Fassung hält fest, dass der Mac jetzt
  am regulären Abstand hängt.
- Der stille H.264-Zwangsrückfall (`encode/mod.rs:195-200`).
- `av1Nutzbar` (`web/src/lib/stream/settings.svelte.ts:156-158`) → das
  `!isMac()` fällt, samt der Begründung darüber (Z. 136–155).
- Doku: `mac-hq-sidecar/README.md` (Abschnitt „No back channel — and what
  follows from it") und `CLAUDE.md` (der Absatz „macOS ist der Sonderfall:
  kein Rückkanal", dazu die Erwähnungen beim Vollbild-Abstand und bei
  `pushProtokoll`).

Das Intra-Refresh-Kästchen bleibt auf macOS aus. Es hängt an
`(isLinux() || isWindows()) && stream.intraRefreshAvailable`
(`ErweiterteOptionen.svelte:41`), und der mac-Sidecar hat schlicht keinen
Intra-Refresh-Code. Das ist kein Rückstand, sondern deckt sich mit der
Vorgabe: periodische Vollbilder sind der Regelfall, Intra-Refresh die
Ausnahme.

## Was nicht dazugehört

- Die Empfangsrichtung — eigener Entwurf, eigener Zweig.
- Intra-Refresh auf macOS. Ausdrücklich nicht Ziel.
- **Die Pacer-Frage.** Welcher der beiden Taktgeber-Algorithmen besser ist,
  bleibt offen. Sie wird umgangen (Trait, plattformeigene Implementierung),
  nicht beantwortet — die Antwort verlangte eine Messung über eine echte
  Strecke, und die steht laut beiden Modulkommentaren ohnehin noch aus.
- **`bandbreite.rs` als eigenständige Vereinheitlichung.** Sie wandert mit
  `mod.rs` mit, weil sie daran hängt; sie wird nicht darüber hinaus angefasst.

## Prüfen

- `cargo test` in beiden Sidecars und in der neuen Crate; `cargo clippy`.
- Die Windows-Regression ist der empfindlichste Punkt: der Sidecar wird über
  den Installer ausgeliefert und ein Fehler hier trifft Bestandsnutzer. Vor dem
  Landen ein echter Stream von einer Windows-Maschine, nicht nur grüne Tests.
- Von Hand: WHIP-Rauchtest gegen ein Wegwerf-MediaMTX (Muster in
  `docs/plans/2026-07-12-whip-win-mac-handover.md`), AV1 über den eigenen Weg,
  PLI-Antwort, RTMPS-Regression.
- Vor dem Push: pytest, `pnpm check`, `pnpm build`, Playwright.

## Auslieferung

Berührt `streaming/win-hq-sidecar/**` und damit den Windows-Installer — ein
Versionswechsel in `desktop/package.json` ist Pflicht, sonst erreicht die
Änderung Bestandsclients nicht.

Changelog-Eintrag: Mac-Nutzer bekommen AV1 zurück und ein spürbar schnelleres
erstes Bild. Stil vor dem Push abstimmen, echte Umlaute, keine Emojis.

## Offen, bewusst

Die Messreihe zum 60-s-Takt lief auf sauberer Leitung, null Nachlieferungen
(`linux-hq-sidecar/src/encode/mod.rs` Z. 770–774). Wie sich der lange Takt
unter echtem Paketverlust verhält, ist ungemessen — das gilt nach diesem
Vorhaben dann auch für macOS. Es spricht nicht gegen den Schritt (der Mac
bekommt denselben Rückkanal, der die Lücke anderswo schliesst), aber es bleibt
eine offene Zahl und wird nicht als geklärt ausgegeben.
