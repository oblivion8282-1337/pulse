//! Vendor-Encoder-Optionen, orientiert an GSR (`src/main.cpp` open_video_hardware).
//!
//! GSR nutzt selbst ffmpeg-Encoder (`h264_nvenc`/`h264_vaapi`) via av_dict —
//! die Settings werden hier nahezu 1:1 nachgebaut. Nur H264 + AV1 (kein HEVC).
//!
//! Rate-Control-Option-Strings unterscheiden sich pro Vendor:
//!   NVENC:  `rc`  = constqp | vbr | cbr
//!   VAAPI:  `rc_mode` = CQP | VBR | CBR  (GROSS)

use std::sync::atomic::{AtomicU8, Ordering};

use ffmpeg_next as ffmpeg;
use ffmpeg::Dictionary;

use crate::system::drm::Vendor;

/// ffmpeg-Encoder-Name für Vendor + Pulse-Codec-Id (h264/av1).
pub fn encoder_name(vendor: Vendor, codec: &str) -> Option<&'static str> {
    match (vendor, codec) {
        (Vendor::Nvidia, "h264") => Some("h264_nvenc"),
        (Vendor::Nvidia, "av1") => Some("av1_nvenc"),
        (Vendor::Amd | Vendor::Intel, "h264") => Some("h264_vaapi"),
        (Vendor::Amd | Vendor::Intel, "av1") => Some("av1_vaapi"),
        _ => None,
    }
}

/// av_dict-Optionen für den Encoder-Open. CBR, Ultra-Low-Latency, kein B-Ref —
/// GSRs Performance-Tune.
///
/// `codec` ist `"h264"` oder `"av1"` — gebraucht fuer die eine Option, die es
/// nur bei H.264 gibt (Begruendung an der Stelle selbst).
pub fn vendor_opts(vendor: Vendor, codec: &str) -> Dictionary<'static> {
    let mut opts = vendor_defaults(vendor, codec);
    apply_override(&mut opts);
    opts
}

/// Wie [`vendor_opts`], aber OHNE `PULSE_ENCODER_OPTS`.
///
/// Für die Fähigkeitsprobe (`probe_encoder`) — die soll beantworten, was die
/// HARDWARE kann, nicht was die gerade laufende Messvariante tut. Floss die
/// Variante mit ein, konnte ein Wert, den der Encoder ablehnt, die Probe
/// scheitern lassen; `caps::supports_codec` meldete dann `false`, und
/// `ops::start` nahm den Codec still auf H.264 zurück. Ergebnis wäre eine
/// H.264-Messung unter AV1-Etikett gewesen — plausibel aussehend und nicht
/// nachweisbar.
pub fn vendor_defaults(vendor: Vendor, codec: &str) -> Dictionary<'static> {
    let mut opts = Dictionary::new();
    // Entropie-Kodierer, NUR H.264. `coder` gibt es bei `h264_nvenc` und
    // `h264_vaapi`; bei `av1_nvenc` und `av1_vaapi` existiert die Option NICHT
    // (2026-07-30 gegen die AVOption-Tabellen beider Encoder geprüft) — AV1
    // hat keine CABAC/CAVLC-Wahl, es kodiert immer arithmetisch.
    //
    // Bis 2026-07-30 stand das unbedingt in BEIDEN Zweigen und wurde bei jedem
    // AV1-Stream still verworfen. Folgenlos, aber es war eine Anweisung ohne
    // Wirkung — und AV1 ist der Standard-Codec, der Wert griff also
    // praktisch nie.
    if codec == "h264" {
        opts.set("coder", "cabac");
    }
    match vendor {
        Vendor::Nvidia => {
            // GSR main.cpp: tune="ll", rc="cbr", b_ref_mode=0, coder=cabac.
            //
            // `tune=ull` statt GSRs `ll` — seit 2026-08-04, und zwar zur
            // ANGLEICHUNG an den Windows-Sidecar, der fuer denselben
            // ffmpeg-Encoder seit jeher `ull` setzt. Dass hier `ll` stand, war
            // kein Abwaegen zwischen beiden, sondern von GSR uebernommen; die
            // beiden Wege sind getrennt entstanden und nie verglichen worden.
            //
            // **Was NVIDIA dazu sagt** (Programmierhandbuch, Tabelle "Tuning
            // info for popular video encoding use-cases"): `ll` fuer "high
            // bandwidth channel with tolerance for bigger occasional frame
            // sizes", `ull` fuer "strictly bandwidth-constrained channel".
            // Also nicht "schneller", sondern gleichmaessigere Bildgroessen —
            // ein doppelt so grosses Bild braucht auf enger Leitung doppelt so
            // lange, und DAS ist die Latenz.
            //
            // **Ungemessen, hier wie dort.** Was die beiden Tunes im Treiber
            // konkret unterschiedlich einstellen, ist nicht veroeffentlicht:
            // ffmpeg reicht die Konstante nur durch (`nvenc.c:1844`), der Rest
            // passiert in NVIDIAs Closed Source. Oeffentliche Messungen zu
            // `ll` gegen `ull` gibt es nicht (2026-08-04 gesucht; zwei
            // arxiv-Papiere, die eine Suchmaschine als Beleg ausgab, vergleichen
            // beide etwas anderes). Der Wechsel ist damit eine
            // Vereinheitlichung, KEIN belegter Gewinn — wer ihn rueckgaengig
            // machen will, braucht dafuer so wenig Begruendung wie er hatte.
            //
            // **Der sichtbarste Unterschied greift ohnehin nicht.** Die
            // Puffergroesse, auf die NVIDIAs Beschreibung direkt zeigt, setzt
            // ffmpeg selbst: ohne `rc_buffer_size` schreibt es
            // `vbvBufferSize = 2 * Bitrate` (`nvenc.c:1183-1186`) — und zwar
            // NACH dem Uebernehmen der Tuning-Voreinstellung
            // (`nvenc_setup_rate_control` laeuft in Zeile 1942, die
            // Preset-Uebernahme in 1865). Zwei Sekunden Puffer also, rund das
            // Sechzigfache von NVIDIAs Low-Latency-Empfehlung (ein Bild,
            // Bitrate/fps) — in BEIDEN Sidecars, und von niemandem entschieden.
            // Ein `bufsize` ist bewusst nicht gesetzt: kleiner hiesse flachere
            // Datenrate, aber mehr sichtbares Pumpen (der Ausgleich ginge ueber
            // den Quantisierer), groesser ist der Daempfungs-Hebel, den der
            // Nutzer am 2026-08-03 wegen der Latenz abgelehnt hat.
            opts.set("tune", "ull");
            opts.set("rc", "cbr");
            opts.set("b_ref_mode", "0");
            // Hier stand mal: "preset/Multipass/rc-lookahead nur bei tune=quality".
            // Das ist FALSCH — 2026-07-19 nachgemessen (RTX 4090, ffmpeg-nvenc):
            // `preset`/`multipass`/`spatial-aq` werden auch mit tune=ll angenommen
            // und verändern den Bitstrom nachweislich (andere Prüfsummen, keine
            // "ignoring"-Warnung).
            //
            // `preset=p2` — dieselbe Bildqualität für deutlich weniger GPU.
            //
            // Bis 2026-07-27 war `preset` hier ungesetzt und lief damit auf dem
            // ffmpeg-Default p4; der Windows-Sidecar setzt p2 seit jeher. Das war
            // kein Abwägen, sondern ein Versehen — wie `zerolatency` einen Tag
            // zuvor. Gemessen (RTX 5080, AV1, echtes Bildschirmmaterial):
            //
            // * Qualität: die GANZE Leiter p1 bis p7 liegt innerhalb von 1,3 VMAF,
            //   über zwei Inhalte (Spiel, Desktop) und zwei Bitraten (4000,
            //   10000). p2 gegen p4 sind 0,2 Punkte bei 4000 kbps — und bei
            //   10000 kbps ist p2 sogar besser (48,8 gegen 48,3). Da ist nichts.
            // * Kosten: Encoder-Block live 11,0 bis 11,9 % statt 17,3 bis 18,0 %
            //   bei 1440p144, und 4,0 statt 6,8 % bei 1440p60. Offline bestätigt
            //   über den Durchsatz: 537 statt 375 Bilder/s bei 1440p, 477 statt
            //   330 bei 4K — der Vorteil bleibt also mit der Pixelzahl erhalten.
            // * Latenz: unverändert (16,9/17,2 gegen 18,2 ms bei 144 fps).
            //
            // Auf dieser Karte ist das folgenlos; es zählt auf schwächeren Karten
            // und bei 4K, wo NICHT end-to-end gemessen werden konnte (der Sender
            // skaliert nie hoch, der Prüfstand-Bildschirm läuft auf 1440p).
            // Volles Protokoll: `streaming/testbench/profiles/bild-2026-07-27-av1.json`
            // im Hauptrepo.
            opts.set("preset", "p2");
            //
            // Zwei Bilder Vorlauf abstellen — der groesste einzelne Posten der
            // Latenzkette. Gemessen am 2026-07-26 (2560x1440, AV1, 10 bit,
            // 4000 kbps): der Encoder gab ein Paket erst heraus, wenn zwei
            // weitere Bilder eingeschoben waren, also 33,3 ms bei 60 fps und
            // 13,889 ms bei 144 fps — beides exakt zwei Bildabstaende. Bei
            // 60 fps war das ein Drittel der gesamten Ende-zu-Ende-Zeit von
            // 96 ms, mehr als Aufnahme, Netz und Player zusammen.
            //
            // `zerolatency` schaltet die Umsortier-Verzoegerung ab, `delay=0`
            // verlangt die Ausgabe beim ersten moeglichen Zeitpunkt (Default
            // ist INT_MAX, also "Encoder entscheidet" — und der entscheidet
            // sich fuer zwei Bilder). Der Windows-Sidecar setzt fuer denselben
            // ffmpeg-Encoder beides seit immer; dass es hier fehlte, war ein
            // Versehen, kein Abwaegen.
            //
            // Ueber `PULSE_NVENC_LOW_DELAY=0` abschaltbar, damit der Vergleich
            // gegen das Ausgangsprofil ohne neuen Build moeglich bleibt.
            if std::env::var("PULSE_NVENC_LOW_DELAY").as_deref() != Ok("0") {
                opts.set("zerolatency", "1");
                opts.set("delay", "0");
            }
            // Absichtlich trotzdem nicht gesetzt: der Gewinn ist zu klein. Auf
            // echtem Bildschirmmaterial bei 4000 kbps bringt p6+multipass+AQ
            // +0,85 VMAF, und selbst mit ALLEM (p7, B-Frames, 30 Bilder
            // Lookahead) sind es nur +1,84 — unterhalb der Wahrnehmungsschwelle,
            // während der Encode-Durchsatz um 40-50 % fällt (bei 4K60 damit
            // grenzwertig). Bei 2000 kbps ist der Gewinn exakt null.
            // Volle Messung: `docs/2026-07-19-hq-encoder-qualitaet-messung.md`
            // im Hauptrepo. Nicht ohne neue Messung daran drehen.
        }
        Vendor::Amd | Vendor::Intel => {
            // GSR main.cpp: rc_mode="CBR", async_depth=3, low_power je Capability,
            // coder=cabac, tier=main (AV1).
            opts.set("rc_mode", "CBR");
            //
            // Encoder-Vorlauf abstellen — das VAAPI-Gegenstueck zu
            // `zerolatency`+`delay=0` im NVENC-Zweig, und derselbe Posten in
            // derselben Groessenordnung.
            //
            // **Mechanik:** ffmpeg gibt bei VAAPI erst dann ein Paket heraus,
            // wenn `async_depth` Bilder in seiner Schlange stehen. Der Vorlauf
            // ist damit (n-1) Bildabstaende. `async_depth=3` kostete also zwei,
            // genau wie NVENC ohne `delay=0`.
            //
            // **Dass es rein um Pipelining geht und nicht um Kodierung, ist
            // bewiesen, nicht geschlossen:** bei gleichem Eingang liefern
            // async_depth 1, 2, 3 und 8 einen BYTE-IDENTISCHEN Bitstrom —
            // gleiche md5, gleiche Groesse, fuer `av1_vaapi` UND `h264_vaapi`.
            // Die Bildqualitaet kann sich dadurch also nicht aendern. Das ist
            // die belastbarere Aussage als die VMAF-Messung darunter, deren
            // Aufloesung bei rund +-7 Punkten liegt (jeder Lauf erwischt ein
            // anderes Stueck des Messbilds).
            //
            // Gemessen 2026-07-30 auf Radeon 780M (VCN 4.0), 2560x1440 bei
            // 60 fps, bewegter Inhalt, je drei Laeufe verschraenkt; Rauschen
            // vorher ueber fuenf Laeufe derselben Einstellung bestimmt
            // (Latenz ±0,13 ms, GPU ±215 us/Bild):
            //
            // | async_depth | AV1 | H.264 |
            // |---|---|---|
            // | 3 (vorher) | 33,62 ms | 33,64 ms |
            // | 2 | 16,97 ms | 16,95 ms |
            // | **1** | **4,75 ms** | **5,84 ms** |
            //
            // `ad3 - ad2` sind 16,69 ms — exakt ein Bildabstand bei 60 fps.
            // Nicht nur die Wirkung stimmt also, sondern die Erklaerung.
            //
            // **Kostet nichts, wo es zaehlt.** GPU-Zeit je Bild unveraendert
            // (AV1 3243 gegen 3220 us, H.264 3125 gegen 3117 — beides
            // innerhalb der Streuung), Bitrate unveraendert bei 4,0 Mbit/s,
            // Bildqualitaet unveraendert (s. Messakte). Der Durchsatz am
            // Anschlag sinkt: offline 505 -> 487 Bilder/s bei 1080p, 334 -> 303
            // bei 1440p, bei 4K gar nicht (dort ist die GPU der Engpass, da
            // ueberlappt ohnehin nichts). Bei 60 fps liegt zwischen Bedarf und
            // Decke Faktor 5 (1440p) bis 2,2 (4K) — der Verlust trifft nur
            // Bildraten, die wir nicht fahren.
            //
            // **Die Streuung steigt** (±0,12 auf ±1,33 ms), genau wie im
            // NVENC-Zweig: der feste Vorlauf hat die echte Schwankung der
            // Encode-Zeit mit versteckt. Auf die Gleichmaessigkeit der Ausgabe
            // wirkt es nicht.
            //
            // Rueckschalter braucht es hier keinen eigenen — `PULSE_ENCODER_OPTS
            // =async_depth=3` stellt den alten Stand ohne Neubau her; genau
            // dafuer ist die Variable da.
            //
            // Volle Messakten: `streaming/testbench/profiles/amd-*-2026-07-30-*.json`
            opts.set("async_depth", "1");
            // low_power: bleibt ungesetzt. Auf AMD scheitert der Encoder-Open
            // damit hart ("Function not implemented", 2026-07-30 nachgemessen) —
            // es ist ein Intel-VDENC-Pfad. Die frühere Notiz "Phase 6
            // capability-gesteuert" ist damit für AMD gegenstandslos.
            //
            // Ebenfalls geprueft und absichtlich NICHT gesetzt (2026-07-30):
            // * `compression_level=4` (die einzige erreichbare Qualitaetsstufe
            //   bei `av1_vaapi` — eine `quality`-Option hat der Encoder nicht):
            //   +166 % GPU-Zeit fuer null Latenzgewinn. Auf einer iGPU ist die
            //   Leiter unbezahlbar, `compression_level=6` traegt 1440p60 gar
            //   nicht mehr (59 Bilder/s offline gemessen).
            // * `quality=1` bei `h264_vaapi`: reisst die Ratenkontrolle,
            //   4,82 statt 4,01 Mbit/s bei +40 % GPU. `compression_level=1` tut
            //   bei AV1 dasselbe (11,3 statt 4,0 Mbit/s). Wer die Leiter naiv
            //   durchmisst, haelt das fuer Qualitaetsgewinn.
            // * `tiles=2x1`: kein Gewinn, +3 % GPU.
        }
    }
    if intra_refresh_gewuenscht() {
        for (k, v) in intra_refresh_opts(vendor) {
            opts.set(k, v);
        }
    }
    opts
}

/// Wunsch aus den Start-Parametern. `None` = nichts gesagt, dann entscheidet
/// die Umgebungsvariable.
///
/// Prozessweit statt als Feld in `EncoderConfig`, weil [`vendor_opts`] und
/// [`intra_refresh_pruefen`] von mehreren Stellen ohne diese Konfiguration
/// gerufen werden — ein Feld müsste durch jede davon durchgereicht werden, und
/// eine vergessene Stelle liefe still im falschen Modus.
static AUS_PARAMETERN: AtomicU8 = AtomicU8::new(UNGESAGT);

const UNGESAGT: u8 = 0;
const AUS: u8 = 1;
const AN: u8 = 2;

/// Den Wunsch der Oberfläche hinterlegen. `ops::start` ruft das einmal je
/// Stream, bevor der Encoder geöffnet wird.
pub fn intra_refresh_setzen(an: bool) {
    AUS_PARAMETERN.store(if an { AN } else { AUS }, Ordering::Relaxed);
}

/// Rollender Intra-Refresh statt periodischer Keyframes?
///
/// Quelle ist der Wunsch aus den Start-Parametern (`overrides.intra_refresh`);
/// ohne ihn `PULSE_INTRA_REFRESH=1`. Die Variable bleibt, weil der Prüfstand
/// den Sidecar direkt fährt, ohne Oberfläche.
///
/// **Warum eine eigene Variable und nicht `PULSE_ENCODER_OPTS`:** die
/// Optionsnamen unterscheiden sich je Vendor (NVENC `intra-refresh`, VAAPI
/// `intra_refresh`). Ein Prüfstand-Skript, das den NVENC-Namen setzt, misst auf
/// einer AMD-Karte einen Keyframe-Lauf unter dem Etikett „Intra-Refresh" — die
/// Sorte Fehler, die eine Messreihe nicht scheitern lässt, sondern verfälscht.
pub fn intra_refresh_gewuenscht() -> bool {
    match AUS_PARAMETERN.load(Ordering::Relaxed) {
        AN => true,
        AUS => false,
        _ => matches!(std::env::var("PULSE_INTRA_REFRESH").as_deref(), Ok("1")),
    }
}

/// Die Encoder-Optionen für rollenden Intra-Refresh, je Vendor.
///
/// Die **Umlaufdauer** steht hier bewusst nicht: sie ergibt sich aus `-g`
/// (`set_gop`, 2 s), und beide Encoder machen daraus dasselbe — NVENC liest
/// `gopLength` als Refresh-Periode und schaltet den GOP danach auf unendlich
/// (`nvenc.c:1309ff`), der VAAPI-Patch genauso.
///
/// `forced-idr` nur bei NVENC: dort wird ein angeforderter Keyframe sonst
/// nicht zwingend als IDR kodiert. VAAPI macht daraus ohnehin eins
/// (2026-08-01 nachgemessen: drei angeforderte Keyframes, drei IDR) — und
/// dass angeforderte Keyframes weiter ankommen, ist die Bedingung, unter der
/// Zuschauer überhaupt in einen Intra-Refresh-Strom einsteigen können.
///
/// **VAAPI braucht ein gepatchtes FFmpeg** (`streaming/ffmpeg-patches/`);
/// upstream gibt es die Option in keiner Version. Fehlt sie, bricht der
/// Encoder-Open mit klarer Meldung ab, statt still weiterzulaufen.
pub fn intra_refresh_opts(vendor: Vendor) -> &'static [(&'static str, &'static str)] {
    match vendor {
        // `no-scenecut` gehoert dazu und fehlte bis 2026-08-02. Ohne die Option
        // schiebt NVENC bei Szenenwechseln von sich aus I-Bilder ein — mitten
        // in einen Strom, der gerade KEINE haben soll. Jedes davon ist bei
        // fester Bitrate ein sichtbarer Ausschlag. Die Labor-Vorlage der
        // erfolgreichen Messung hatte sie (`-intra-refresh 1 -no-scenecut 1`),
        // unsere Optionsliste nicht.
        Vendor::Nvidia => &[("intra-refresh", "1"), ("forced-idr", "1"), ("no-scenecut", "1")],
        Vendor::Amd | Vendor::Intel => &[("intra_refresh", "1")],
    }
}

// **Hier stand bis 2026-08-02 ein `traegt_intra_refresh(codec) == "h264"`.**
// Die Begruendung — AV1 koenne dem Zuschauer mangels `recovery_point`-SEI nicht
// signalisieren, wann die Auffrisch-Welle durch ist, weshalb der Empfaenger
// dauerhaft Vollbilder anfordere — war eine Fehldeutung des Pumpens, das an
// jenem Tag zu sehen war. Sie ist widerlegt, und zwar durch eine Messung, die
// es vorher schon gab: `streaming/testbench/profiles/
// hq-2026-07-31-intra-refresh-echter-sender.json` faehrt `av1_nvenc` in 10 bit
// ueber den ausgelieferten Weg und zaehlt im Intra-Refresh-Lauf **8 Vollbilder
// in 1248 s** gegen 216 in 427 s im Keyframe-Lauf. Die Akte belegt die Mechanik
// zusaetzlich am ffmpeg-Quelltext (`nvenc_setup_av1_config` setzt
// `enableIntraRefresh=1` und danach `gopLength = NVENC_INFINITE_GOPLENGTH`).
//
// Die echte Quelle der Vollbild-Flut sass beim Zuschauer: Chromiums
// dav1d-Anbindung lehnt `bpc != 8` ab, bekommt bei 10-bit-AV1 nie ein Bild
// zustande und fordert endlos Vollbilder an — auch dann, wenn das Bild laengst
// im eigenen Fenster laeuft und niemand dieses `<video>` ansieht. Abgeklemmt
// wird das dort, wo es entsteht (`web/src/lib/stream/components/
// HqStreamKeepAlive.svelte`), nicht durch eine Codec-Sperre im Encoder.
//
// Kein neuer Ersatz an dieser Stelle: es gibt keinen Codec, der Intra-Refresh
// hier nicht traegt. Was ihn nicht kann, faellt schon in `intra_refresh_pruefen`
// mit klarer Meldung durch.

/// Reicht dieses FFmpeg Intra-Refresh für `vendor` und `codec` durch?
///
/// **Warum es diese Frage zusätzlich zu [`intra_refresh_pruefen`] gibt:** die
/// Prüfung dort läuft beim Encoder-Open, also erst wenn der Nutzer schon auf
/// „Stream starten" geklickt hat, und ihre Antwort ist ein Abbruch. Für die
/// Oberfläche ist das zu spät — sie soll das Kästchen gar nicht erst anbieten,
/// wenn dieses FFmpeg die Betriebsart nicht kann. Dasselbe Muster wie bei
/// `ten_bit`: ein nicht angebotener Schalter ist besser als einer, der beim
/// Start eine Fehlermeldung produziert.
///
/// Anders als [`super::probe_encoder`] wird hier **keine Hardware angefasst** —
/// die Frage ist nicht „kann die Karte das", sondern „hat dieses FFmpeg die
/// Option". Deshalb kein Geräte-Kontext, kein `open`, nur die Optionsliste des
/// Encoders. Die Hardware-Frage beantwortet ohnehin die Codec-Probe, die
/// Intra-Refresh mitprobt (`vendor_defaults` setzt die Optionen, sobald der
/// Wunsch gesetzt ist).
///
/// Auf NVIDIA ist die Antwort immer ja (Option upstream), auf VAAPI nur mit
/// unserem Patch (`streaming/ffmpeg-patches/`).
pub fn intra_refresh_verfuegbar(vendor: Vendor, codec: &str) -> bool {
    let Some(name) = encoder_name(vendor, codec) else {
        return false;
    };
    let Some(desc) = ffmpeg::codec::encoder::find_by_name(name) else {
        return false; // Encoder gar nicht ins FFmpeg gelinkt
    };
    let Ok(mut enc) = ffmpeg::codec::context::Context::new_with_codec(desc)
        .encoder()
        .video()
    else {
        return false;
    };
    // SAFETY: `enc` lebt bis zum Ende der Funktion, der Zeiger stammt aus ihm
    // und ist damit gueltig; die Pruefung liest ihn nur (`av_opt_find`).
    unsafe { fehlende_intra_refresh_option(enc.as_mut_ptr(), vendor) }.is_none()
}

/// Welche der für Intra-Refresh nötigen Optionen kennt dieser Encoder NICHT?
/// `None` = alle da.
///
/// Eine Stelle für zwei Fragen: [`intra_refresh_verfuegbar`] fragt nur, ob
/// etwas fehlt, [`intra_refresh_pruefen`] braucht zusätzlich den Namen für
/// seine Fehlermeldung. Getrennt ausgeschrieben könnten die beiden Listen
/// auseinanderlaufen — und dann böte die Oberfläche eine Betriebsart an, die
/// der Start ablehnt, oder umgekehrt.
///
/// # Safety
///
/// `ctx` muss ein gueltiger `AVCodecContext` sein und den Aufruf ueberleben.
unsafe fn fehlende_intra_refresh_option(
    ctx: *mut ffmpeg::ffi::AVCodecContext,
    vendor: Vendor,
) -> Option<&'static str> {
    intra_refresh_opts(vendor)
        .iter()
        // SAFETY: `ctx` ist laut Kontrakt gueltig und wird nur gelesen.
        .find(|(key, _)| !unsafe { kennt_option(ctx, key) })
        .map(|(key, _)| *key)
}

/// Vor dem Encoder-Open prüfen, ob ein verlangter Intra-Refresh überhaupt
/// ankommt — und den Start verweigern, wenn nicht.
///
/// **Warum hier ein Fehler steht, wo [`warn_unknown`] nur warnt:** eine
/// unbekannte Option aus `PULSE_ENCODER_OPTS` ist die Eingabe des Messenden und
/// soll ihn nicht am Streamen hindern. Intra-Refresh dagegen ist die
/// Betriebsart selbst: fällt sie aus, läuft ein Keyframe-Strom unter ihrem
/// Etikett weiter — eine Messung, die nicht scheitert, sondern täuscht.
///
/// Auf VAAPI trifft das jedes ungepatchte FFmpeg, also praktisch jedes System
/// (`streaming/ffmpeg-patches/`).
///
/// # Safety
///
/// Wie [`warn_unknown`]: `ctx` muss ein gueltiger `AVCodecContext` sein und den
/// Aufruf ueberleben. Die Funktion liest ihn nur.
pub unsafe fn intra_refresh_pruefen(
    ctx: *mut ffmpeg::ffi::AVCodecContext,
    vendor: Vendor,
    codec_name: &str,
) -> anyhow::Result<()> {
    if !intra_refresh_gewuenscht() {
        return Ok(());
    }
    // SAFETY: `ctx` ist laut Kontrakt gueltig und wird nur gelesen.
    if let Some(key) = unsafe { fehlende_intra_refresh_option(ctx, vendor) } {
        anyhow::bail!(
            "PULSE_INTRA_REFRESH=1, aber '{codec_name}' kennt '{key}' nicht — \
             dieses FFmpeg reicht Intra-Refresh nicht durch. \
             Patch und Bauanleitung: streaming/ffmpeg-patches/"
        );
    }
    Ok(())
}

/// Meldet Encoder-Optionen, die dieser Encoder gar nicht kennt.
///
/// **Warum das noetig ist:** `avcodec_open2` bekommt die Optionen als
/// `av_dict`. Was es nicht zuordnen kann, bleibt im Dictionary liegen und wird
/// beim Aufraeumen verworfen — **ohne eine einzige Logzeile**. Die ffmpeg-CLI
/// meldet Unbekanntes, weil sie den Rest hinterher selbst prueft; ueber die
/// Bibliothek passiert das nicht, und `open_with` prueft es auch nicht.
///
/// Das ist genau die Fehlerform, an der eine Messreihe scheitert, ohne es zu
/// zeigen: ein Tippfehler oder eine Option, die dieser Encoder nicht hat,
/// wirkt nicht — der Lauf sieht aber normal aus, und die Zahl wird als
/// Ergebnis gedeutet. Dieselbe Falle wie das `netem`, das nachweislich nichts
/// verwirft (s. `streaming/testbench/README.md`).
///
/// `AV_OPT_SEARCH_CHILDREN` erfasst neben den generischen
/// `AVCodecContext`-Optionen auch die privaten des Encoders, also sowohl
/// `compression_level` als auch `async_depth`.
///
/// Nur eine Warnung, kein Fehler. [`vendor_defaults`] erzeugt seit 2026-07-30
/// keinen unbekannten Schluessel mehr (`coder` ist auf H.264 begrenzt), die
/// einzige Quelle ist damit `PULSE_ENCODER_OPTS` — also eine ausdrueckliche
/// Eingabe des Messenden, die ihn nicht am Streamen hindern soll.
///
/// # Safety
///
/// `ctx` muss ein gueltiger `AVCodecContext` sein und den Aufruf ueberleben.
/// Die Funktion liest ihn nur (`av_opt_find`), sie veraendert nichts.
pub unsafe fn warn_unknown(ctx: *mut ffmpeg::ffi::AVCodecContext, opts: &Dictionary<'_>) {
    for (key, value) in opts.iter() {
        // SAFETY: der Kontrakt dieser Funktion ist der von `kennt_option`.
        if !unsafe { kennt_option(ctx, key) } {
            tracing::warn!(
                target: "encode",
                key,
                value,
                "Encoder-Option unbekannt — ffmpeg verwirft sie still, sie wirkt NICHT"
            );
        }
    }
}

/// Kennt dieser Encoder die Option? Antwort desselben `av_opt_find`, das
/// [`warn_unknown`] benutzt — nur als Frage statt als Warnung, für den Fall,
/// dass eine fehlende Option ein Abbruchgrund ist statt einer Randnotiz.
///
/// # Safety
///
/// Wie [`warn_unknown`]: `ctx` muss ein gueltiger `AVCodecContext` sein und den
/// Aufruf ueberleben. Die Funktion liest ihn nur.
pub unsafe fn kennt_option(ctx: *mut ffmpeg::ffi::AVCodecContext, name: &str) -> bool {
    let Ok(name) = std::ffi::CString::new(name) else {
        return false;
    };
    // SAFETY: `ctx` ist laut Kontrakt gueltig; `name` lebt bis zum Ende des
    // Aufrufs. `av_opt_find` liest nur.
    let gefunden = unsafe {
        ffmpeg::ffi::av_opt_find(
            ctx.cast(),
            name.as_ptr(),
            std::ptr::null(),
            0,
            ffmpeg::ffi::AV_OPT_SEARCH_CHILDREN as i32,
        )
    };
    !gefunden.is_null()
}

/// Zusaetzliche Encoder-Optionen aus `PULSE_ENCODER_OPTS`, Form
/// `"preset=p6,multipass=qres,spatial-aq=1"`. Ueberschreibt die Vorgaben oben.
///
/// **Zweck ist das MESSEN, nicht das Einstellen.** Die Frage "welche
/// Encoder-Einstellung ist die richtige" ist nur durch Vergleich zu
/// beantworten, und ein Vergleich, der je Variante einen Neubau verlangt, wird
/// nach der dritten Variante nicht mehr gemacht. Mit dieser Variable faehrt der
/// Pruefstand (`streaming/testbench/`) eine ganze Messreihe an einem Stueck.
///
/// Die WERTE werden nicht geprueft — wer hier Unsinn setzt, misst Unsinn. Die
/// SCHLUESSEL dagegen schon: [`warn_unknown`] meldet vor dem Open jeden, den
/// der Encoder nicht kennt. Ohne das war eine wirkungslose Messvariante von
/// einer wirksamen nicht zu unterscheiden.
fn apply_override(opts: &mut Dictionary<'_>) {
    let Ok(roh) = std::env::var("PULSE_ENCODER_OPTS") else { return };
    for paar in roh.split(',') {
        let Some((k, v)) = paar.split_once('=') else { continue };
        let (k, v) = (k.trim(), v.trim());
        if k.is_empty() {
            continue;
        }
        tracing::info!(target: "encode", key = k, value = v, "Encoder-Option aus der Umgebung");
        opts.set(k, v);
    }
}

#[cfg(test)]
mod intra_refresh_tests {
    use super::*;

    /// Der Weg vom Start-Parameter bis in die Encoder-Optionen — die Strecke,
    /// auf der der Wunsch am 2026-08-02 verlorenging (die Oberflaeche schickte
    /// das Feld gar nicht erst mit, und nichts fiel auf).
    ///
    /// Laeuft seriell: die Betriebsart ist prozessweit, parallele Tests wuerden
    /// einander den Zustand umstellen.
    #[test]
    fn wunsch_erreicht_die_encoder_optionen() {
        intra_refresh_setzen(true);
        assert!(intra_refresh_gewuenscht());
        for vendor in [Vendor::Nvidia, Vendor::Amd, Vendor::Intel] {
            let opts = vendor_opts(vendor, "h264");
            for (key, wert) in intra_refresh_opts(vendor) {
                assert_eq!(
                    opts.get(key),
                    Some(*wert),
                    "{key} fehlt in den Optionen fuer {vendor:?}",
                );
            }
        }

        intra_refresh_setzen(false);
        assert!(!intra_refresh_gewuenscht());
        for vendor in [Vendor::Nvidia, Vendor::Amd, Vendor::Intel] {
            let opts = vendor_opts(vendor, "h264");
            for (key, _) in intra_refresh_opts(vendor) {
                assert_eq!(opts.get(key), None, "{key} steht trotz Absage in den Optionen");
            }
        }
    }
}
