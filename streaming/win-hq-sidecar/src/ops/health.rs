//! `health` — Capability-Probe.
//!
//! Wire-form mirrors `gsr-sidecar/control.py::op_health`:
//!
//! ```jsonc
//! {"ok": true, "gsr": {"available": ..., "source": ..., "is_flatpak": ...,
//!                       "path": ..., "version": ..., "vendor": ...,
//!                       "display_server": ..., "video_codecs": [...],
//!                       "capture_options": [...], "has_flv_patch": ...}}
//! ```
//!
//! Available = there is at least one hardware adapter found via DXGI. The
//! renderer's `state.svelte.ts:59` flips `stream.gsrAvailable` on this, which
//! ungates the HQ-Stream button (further gated on `isLinux()` until we deploy
//! a web build that also lets Windows through — covered in a later session).
//!
//! `has_flv_patch` stays `null` until the FFmpeg-LGPL build with the Opus-FLV
//! patch lands (Stage 4 in the task list).

use anyhow::Result;
use serde_json::{Map, Value, json};

use crate::encode::{auffrischung, zehnbit};
use crate::system::dxgi;

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    let adapters = dxgi::list_adapters().unwrap_or_default();
    let primary = adapters.first();

    let (available, source, vendor, video_codecs, path) = match primary {
        Some(a) => (
            true,
            "builtin", // Linux uses: env|flatpak|custom|system|missing
            Some(a.vendor()),
            a.supported_video_codecs(),
            std::env::current_exe()
                .ok()
                .and_then(|p| p.to_str().map(str::to_string)),
        ),
        None => (false, "missing", None, Vec::new(), None),
    };

    // Zusatzfelder gegenüber Python/mac, gleiche Namen wie im Linux-Sidecar.
    // Ältere Sidecars melden sie nicht — Konsumenten lesen `undefined` als
    // `false` (`web/src/lib/stream/state.svelte.ts`).
    //
    // `ten_bit` hängt am AV1-Zero-Copy-Weg (P010-Pool; auf AMD zusätzlich
    // `bitdepth=10` an `av1_amf`, auf NVIDIA genügt der Pool — Begründung und
    // Messung in `encode::opts`), nicht am Codec allein; `intra_refresh` daran,
    // ob der Encoder, der bei dieser Kombination WIRKLICH läuft, die
    // Betriebsart trägt — auf AMD ist das AV1, nicht H.264
    // (`encode::auffrischung`).
    //
    // **Für AMD und NVIDIA ist das Ja am fertigen Strom belegt** (2026-08-01
    // Radeon 780M, 2026-08-11 RTX 5080). **Für Intel ist es Nein, und das
    // stimmt jetzt auch.** Bis zum 2026-08-11 fragte die Zeile hier nur, ob es
    // überhaupt einen Encoder für (Vendor, Codec) gibt — Intel hat `av1_qsv`
    // im Angebot, also stand hier `true`, obwohl Intel über die CPU-Pipeline
    // läuft (`VideoCodec::encode_path`), die 10 bit strukturell nicht trägt.
    // Ein 10-bit-Wunsch kam dort als 8-bit-Strom heraus, und die
    // Fähigkeitsmeldung hatte es zugesagt. `zehnbit::verfuegbar` fragt jetzt
    // denselben Encode-Weg mit, den `zehnbit::pruefen` beim Start prüft
    // (`stream_controller::run_pipeline`, Gegenstück zu `encode::hdr::pruefen`
    // für HDR) — die Lücke ist damit geschlossen, nicht nur benannt.
    let ten_bit = vendor.is_some_and(|v| zehnbit::verfuegbar(v, &video_codecs));
    let intra_refresh = vendor.is_some_and(|v| auffrischung::verfuegbar(v, &video_codecs));
    // **`hdr` ist bewusst die GERÄTE-Frage, nicht die Tages-Frage.** Ob HDR im
    // Windows-Umschalter gerade an ist, steht hier NICHT drin — sonst
    // verschwände das Kästchen aus der Oberfläche, sobald jemand HDR
    // ausschaltet, und niemand käme darauf, woran es liegt. Ob der Schirm im
    // Moment mitspielt, sagt der Start (`encode::hdr::pruefen`), und zwar mit
    // einer Meldung, die den Windows-Schalter nennt.
    let hdr = vendor.is_some_and(|v| crate::encode::hdr::verfuegbar(v, &video_codecs));

    let mut gsr = json!({
        "available": available,
        "source": source,
        "is_flatpak": false,
        "display_server": "windows",
        "video_codecs": video_codecs,
        "capture_options": ["window", "monitor", "region"], // WGC kann alle drei
        "has_flv_patch": Value::Null,
        "ten_bit": ten_bit,
        "intra_refresh": intra_refresh,
        "hdr": hdr,
    });
    if let Some(p) = path {
        gsr["path"] = Value::String(p);
    }
    if let Some(v) = vendor {
        gsr["vendor"] = Value::String(v.to_string());
    }

    let mut out = Map::new();
    out.insert("gsr".to_string(), gsr);
    Ok(out)
}
