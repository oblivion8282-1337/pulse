# Ein eigener WHIP-Sender für macOS — Entwurf (2026-08-20)

Ziel: der mac-Sidecar sendet über einen eigenen WebRTC-Sendeweg statt über
ffmpegs WHIP-Muxer. Damit bekommt macOS einen **RTCP-Rückkanal**, und der
Vollbild-Abstand darf von 2 s auf die regulären 60 s.

**Zweite Fassung.** Der erste Stand dieses Entwurfs versprach zwei Dinge und
schnitt die Arbeit anders zu; beides ist am selben Tag korrigiert worden. Die
Abschnitte „Was dieser Entwurf zurücknimmt" und „Zuschnitt" sagen, warum.

Schwesterentwurf: `2026-08-20-mac-player-design.md` (Empfangsrichtung, umgesetzt
auf `feat/mac-player`).

## Warum

Seit dem 2026-08-18 liefert `pushProtokoll` immer WHIP. Auf macOS geht
`http(s)://` aber an ffmpegs WHIP-Muxer (`mac-hq-sidecar/src/encode/mod.rs`,
`url_format_hint` → `Some("whip")`), und der hat **keinen Rückkanal zur
Anwendung**. Eine Vollbild-Anforderung des Zuschauers (RTCP PLI/FIR) erreicht
den Encoder nie.

Am 2026-07-28 auf Linux gemessen: ohne Rückkanal steht das Bild nach einem
Paketverlust bis zum nächsten regulären Vollbild — bei 0,2 % Verlust in 7 bis 9
von 17 Sekunden. Mit ihm sind es 0 bis 1, und die Bildrate geht von 0 auf 60.

Daraus folgt der macOS-Sonderfall, der am 2026-08-19 ehrlich gemacht statt
versteckt wurde: der **Vollbild-Abstand bleibt bei 2 s**
(`KEYFRAME_SEKUNDEN_UNBEDENKLICH`), während Linux und Windows auf 60 s stehen.
Mit 60 s ohne Anforderungspfad wartete ein beitretender Zuschauer bis zu 60 s
auf sein erstes Bild — und der native Player gibt nach 20 s auf
(`pulse-player/src/decode.rs:289`).

Der Preis des 2-s-Takts ist messbar. An der echten Leitung (Linux, AV1 1080p60
@2000 kbps): Stoß-Fenster **4,06 % bei 30 s gegen 2,16 % bei 60 s**, p99/Rate
4,1× gegen 2,8×. Ein Vollbild wiegt ~110 kB, ein normales Bild ~4 kB. Der Mac
sendet heute alle zwei Sekunden eines.

## Was dieser Entwurf zurücknimmt

**Der erste Stand behauptete, der eigene Sender hebe „beide Einschränkungen auf
einmal" auf — den 2-s-Abstand *und* die AV1-Sperre. Der AV1-Teil ist falsch.**

AV1-Encode auf macOS ist dreifach verriegelt, und der Muxer ist nur der dritte:

| Riegel | Status | von diesem Entwurf gelöst |
|---|---|---|
| `av1_videotoolbox`-Encoder in der gelinkten FFmpeg | existiert in 8.0.1 nicht | nein |
| Hardware kann AV1 encodieren | kein Apple-Chip kann das; M3+ kann AV1 nur **dekodieren** | nein |
| ffmpegs WHIP-Muxer trägt kein AV1 | ja | **ja** |

`caps.rs` sagt das bereits selbst („FFmpeg 8.0.1 has no `av1_videotoolbox`, so
AV1 is hidden today"), und `gpuHasAv1` im Frontend fragt genau diese Fähigkeit
ab. Der zusätzliche `!isMac()`-Riegel in `av1Nutzbar` hängt allein am Muxer und
darf nach diesem Vorhaben fallen — **aber AV1 wird dadurch auf heutiger
Hardware nicht nutzbar.** Es bleibt bei `gpuHasAv1`, und das ist der richtige
Test.

Nachgeprüft am 2026-08-20 auf einem M2: die gelinkte FFmpeg meldet als
VideoToolbox-Encoder nur `h264_videotoolbox`, `hevc_videotoolbox` und
`prores_videotoolbox`.

## Zuschnitt: der Mac bekommt eine eigene Kopie

**Auch das ist gegenüber dem ersten Stand geändert.** Dort sollte der Sendeweg
in eine gemeinsame Crate `streaming/pulse-whip/` wandern, an die sich alle drei
Sidecars hängen. Der Grund dafür war gut — `av1.rs` und `sdp.rs` sind zwischen
Windows und Linux in der Logik **bitgleich** (496 bzw. 220 Codezeilen, null
Abweichung), das sind 716 Zeilen bestehende Doppelung ohne Zwillings-Test.

Was dagegen entschieden hat, ist nicht die Architektur, sondern die
**Prüfbarkeit**: Weder `win-hq-sidecar` noch `linux-hq-sidecar` bauen auf einem
Mac. Dem einen fehlen `ffmpeg-dist/` und der gepatchte `windows-capture`-Vendor,
der andere hängt an `ashpd` (Wayland-Portal über zbus) und `drm-fourcc`. Eine
Extraktion würde also **produktiven, ausgelieferten Code auf zwei Plattformen
anfassen, den niemand hier übersetzen, geschweige denn testen kann.** Ein nicht
kompilierter Adapter an einem ausgelieferten Sidecar ist schlechter als gar
keiner.

Deshalb: **`mac-hq-sidecar/src/whip/` wird eine Kopie der Linux-Fassung.**
Windows und Linux werden nicht angefasst.

Vorlage ist Linux und nicht Windows, aus drei Gründen: der mac-Sidecar ist
strukturell näher (beide gabeln über ein `enum Ausgabe`, nicht über eine
Senken-Registry), die Linux-Fassung ist die kleinere (1.936 gegen 2.225 Zeilen),
und sie kommt ohne den `fern_aktiv`-Sonderfall der Fernsteuerung aus, den es auf
macOS nicht gibt.

### Was das kostet, offen benannt

Die Doppelung wächst von zwei Fassungen auf drei. Das ist der bewusst bezahlte
Preis, und er wird nicht schöngeredet:

- **`av1.rs` und `sdp.rs` werden wortgleich übernommen und per Zwillings-Test
  festgehalten** — dasselbe Muster wie `pulse-player/tests/zwillinge.rs`, das
  `include_str!` auf beide Pfade legt. Ein Kommentar allein genügt nicht; beim
  älteren Paar `zeitbasis.rs` ist genau so unbemerkt eine Abweichung
  entstanden.
- **`mod.rs` und `pacer.rs` können nicht wortgleich sein** — sie greifen auf
  crate-eigene Module zurück (`events`, `keyframe`, `zeitbasis`). Sie tragen
  stattdessen einen Kopfvermerk, von welcher Fassung sie stammen und was bei
  einer Änderung dort mitzuziehen ist.
- Die Extraktion in eine gemeinsame Crate bleibt der richtige nächste Schritt,
  **sobald jemand mit Zugang zu einer Windows- und einer Linux-Maschine sie
  fahren kann.** Der verworfene Zuschnitt ist in der Git-Historie dieses
  Entwurfs vollständig erhalten, samt der Vergleichstabelle.

## Aufbau

### C1 — Der Sendeweg im mac-Sidecar

`streaming/mac-hq-sidecar/src/whip/` mit `av1.rs`, `sdp.rs`, `mod.rs`,
`pacer.rs` nach dem Vorbild von `linux-hq-sidecar/src/whip/`. Neue
Abhängigkeiten in der Crate: `webrtc` 0.17, `rtcp` 0.17, `bytes`, `tokio`,
`reqwest` (rustls) — **in genau den Fassungen der anderen Sidecars.** Die
tokio-Laufzeit lebt gekapselt im Sendeweg (`OnceLock`, zwei Worker); der
Sidecar bleibt im Übrigen synchron, wie Windows es vormacht.

Zwillings-Test für `av1.rs` und `sdp.rs` gegen die Linux-Fassung.

### C2 — Der Sidecar sendet selbst

`url_format_hint` gibt für `http(s)://` nicht mehr `Some("whip")` an ffmpegs
Muxer. Statt des hart verdrahteten `MuxWriter` tritt ein
`enum Ausgabe { Mux(MuxWriter), Whip(Arc<WhipSender>) }`, Vorbild
`linux-hq-sidecar/src/encode/mod.rs:60-66`. RTMPS bleibt beim Muxer.

Zu beachten: über den Muxer gehen Pakete mit `rescale_ts` und Stream-Index,
über WHIP **ohne beides**. Und `global_header = false` — SPS/PPS müssen über RTP
im Strom mitlaufen.

Die Naht liegt vollständig hinter `VideoEncoder`; `stream_controller.rs` bleibt
unberührt.

### C3 — Der Vollbild-Anforderungspfad

Der mac-Sidecar hat heute **kein** `request_keyframe` und kein `pict_type=I`.
`venc.set_gop(...)` ist der einzige Keyframe-Schalter.

Der Weg über VideoToolbox ist nachgewiesen vorhanden: `libavcodec` trägt
`kVTEncodeFrameOptionKey_ForceKeyFrame`, und `videotoolboxenc.c` setzt den
Schlüssel, wenn ein Eingabe-Frame `pict_type == AV_PICTURE_TYPE_I` trägt —
unabhängig vom HW-Frames-Kontext, der Zero-Copy-Pfad bleibt also intakt.

Ein Vorteil gegenüber Linux und Windows: dort muss `pict_type` pro Bild
zurückgesetzt werden, weil die Frames aus einem Pool stammen. Auf macOS wird der
`AVFrame` je Bild frisch alloziert — das Problem entsteht gar nicht.

**Die Drossel ist Pflicht**, sonst legt ein Zuschauer mit PLI-Sturm den Encoder
lahm. Ihr Deckel hängt an `KEYFRAME_SEKUNDEN_UNBEDENKLICH` — genau deshalb
bleibt die Konstante bestehen, auch wenn die Vorgabe auf 60 s geht.

### C4 — Den Sonderfall zurücknehmen

Erst wenn C3 nachgewiesen ist, und dann zusammen: die Vorgabe in
`abstand_sekunden_aus` auf die regulären 60 s · `warne_bei_langem_abstand_ohne_
rueckkanal` wird zur Prüfung, dass der Rückkanal steht · die beiden Tests
(`ohne_rueckkanal_gilt_der_unbedenkliche_abstand`, `bilder_aus_sekunden_nie_null`)
werden **ersetzt, nicht gelöscht** · der H.264-Zwangsrückfall für den
WHIP-Muxer entfällt · `!isMac()` in `av1Nutzbar` fällt, samt der Begründung
darüber, die durch eine ehrliche ersetzt wird (es bleibt bei `gpuHasAv1`, und
AV1 ist auf heutiger Mac-Hardware weiterhin nicht nutzbar) · dazu
`mac-hq-sidecar/README.md` und `CLAUDE.md`.

**Der andere Rückfall bleibt**: `videotoolbox_encoder` fällt auf
`h264_videotoolbox` zurück, wenn `caps::supports_codec` nein sagt. Das ist eine
Hardware-Fähigkeitsprüfung und hat mit WHIP nichts zu tun.

Das Intra-Refresh-Kästchen bleibt auf macOS aus — der Sidecar hat schlicht
keinen Intra-Refresh-Code, und das deckt sich mit der Vorgabe: periodische
Vollbilder sind der Regelfall.

## Was nicht dazugehört

- **AV1 auf macOS.** Eigenes Thema, siehe oben — es fehlt der Encoder, nicht
  der Sendeweg.
- **Die Extraktion in eine gemeinsame Crate.** Richtig, aber nicht auf dieser
  Maschine prüfbar.
- **Die Pacer-Frage.** Windows und Linux lösen die Paketverteilung verschieden
  (Windows teilt das Sendefenster, Linux hält einen festen Gruppenabstand von
  2500 µs); welcher Weg besser ist, ist ungemessen und bleibt es. Der Mac
  übernimmt die Linux-Fassung, weil er auch sonst von dort kopiert.
- Windows und Linux. Werden nicht angefasst.

## Prüfen

Alles auf dieser Maschine prüfbar — das ist der Vorzug dieses Zuschnitts.

- `cargo test` und `cargo clippy` im mac-Sidecar, inklusive des Zwillings-Tests.
- WHIP-Rauchtest gegen ein Wegwerf-MediaMTX (Muster in
  `docs/plans/2026-07-12-whip-win-mac-handover.md`), danach RTMPS-Regression.
- **Der eigentliche Nachweis**: zwei Clients, der zweite tritt später bei und
  muss sein erstes Bild sofort bekommen statt nach bis zu 60 s. Ohne diesen
  Nachweis darf C4 nicht laufen.
- Vor dem Push: pytest, `pnpm check`, `pnpm build`, Playwright.

## Auslieferung

Berührt `streaming/mac-hq-sidecar/**` und `web/`. Ein Version-Bump ist fällig;
ob er mit `feat/mac-player` zusammenfällt, entscheidet die Reihenfolge beim
Landen. Changelog-Eintrag: beitretende Zuschauer sehen sofort ein Bild, und der
Mac sendet weniger Vollbilder. Stil vorher abstimmen, echte Umlaute, keine
Emojis.

## Offen, bewusst

- Der 60-s-Takt unter echtem Paketverlust ist ungemessen (die Messreihe lief auf
  sauberer Leitung, null Nachlieferungen). Das gilt nach diesem Vorhaben auch
  für macOS.
- Die dritte Kopie des Sendewegs. Siehe „Was das kostet".
