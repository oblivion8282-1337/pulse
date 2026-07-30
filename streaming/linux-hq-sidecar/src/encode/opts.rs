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
pub fn vendor_opts(vendor: Vendor) -> Dictionary<'static> {
    let mut opts = Dictionary::new();
    match vendor {
        Vendor::Nvidia => {
            // GSR main.cpp: tune="ll", rc="cbr", b_ref_mode=0, coder=cabac.
            opts.set("tune", "ll");
            opts.set("rc", "cbr");
            opts.set("b_ref_mode", "0");
            opts.set("coder", "cabac");
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
            opts.set("coder", "cabac");
            // low_power: Phase 4 erstmal aus (EncSlice); Phase 6 capability-gesteuert.
        }
    }
    apply_override(&mut opts);
    opts
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
/// Die Werte werden NICHT geprueft — ffmpeg meldet Unbekanntes selbst und
/// ignoriert es. Wer hier etwas Unsinniges setzt, misst Unsinn; das ist der
/// Preis dafuer, dass jede Encoder-Option ohne Code-Aenderung erreichbar ist.
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
