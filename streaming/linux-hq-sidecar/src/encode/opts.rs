//! Vendor-Encoder-Optionen, orientiert an GSR (`src/main.cpp` open_video_hardware).
//!
//! GSR nutzt selbst ffmpeg-Encoder (`h264_nvenc`/`h264_vaapi`) via av_dict —
//! die Settings werden hier nahezu 1:1 nachgebaut. Nur H264 + AV1 (kein HEVC).
//!
//! Rate-Control-Option-Strings unterscheiden sich pro Vendor:
//!   NVENC:  `rc`  = constqp | vbr | cbr
//!   VAAPI:  `rc_mode` = CQP | VBR | CBR  (GROSS)

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
            opts.set("tune", "ll");
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
            opts.set("async_depth", "3");
            // low_power: bleibt ungesetzt. Auf AMD scheitert der Encoder-Open
            // damit hart ("Function not implemented", 2026-07-30 nachgemessen) —
            // es ist ein Intel-VDENC-Pfad. Die frühere Notiz "Phase 6
            // capability-gesteuert" ist damit für AMD gegenstandslos.
        }
    }
    opts
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
        let Ok(name) = std::ffi::CString::new(key) else { continue };
        // SAFETY: `ctx` ist laut Kontrakt gueltig; `name` lebt bis zum Ende
        // der Iteration. `av_opt_find` liest nur.
        let gefunden = unsafe {
            ffmpeg::ffi::av_opt_find(
                ctx.cast(),
                name.as_ptr(),
                std::ptr::null(),
                0,
                ffmpeg::ffi::AV_OPT_SEARCH_CHILDREN as i32,
            )
        };
        if gefunden.is_null() {
            tracing::warn!(
                target: "encode",
                key,
                value,
                "Encoder-Option unbekannt — ffmpeg verwirft sie still, sie wirkt NICHT"
            );
        }
    }
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
