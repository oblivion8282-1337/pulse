//! `health` — capability probe.
//!
//! Wire-form mirrors `gsr-sidecar/control.py::op_health`:
//!
//! ```jsonc
//! {"ok": true, "gsr": {"available": ..., "source": ..., "is_flatpak": ...,
//!                       "path": ..., "version": ..., "vendor": ...,
//!                       "display_server": ..., "video_codecs": [...],
//!                       "capture_options": [...], "has_flv_patch": ...,
//!                       "tls_backend": "gnutls"|"openssl"|...}}
//! ```
//!
//! Auf Linux ist der Encoder VAAPI (AMD/Intel) bzw. NVENC (Nvidia) — beides
//! über das gelinkte FFmpeg. `video_codecs` ist die echt hardware-encodierbare
//! Menge (Phase 3: echte Probe; Phase 1: statisch h264+av1). `tls_backend`
//! verrät, ob `tls_verify=0` für self-signed MediaMTX-certs mit dem
//! System-FFmpeg funktioniert (GnuTLS/OpenSSL ja; siehe tls_probe-Example).
//!
//! Anders als der Python-GSR-Sidecar: `available=true` heißt hier „Sidecar
//! selbst kann capturen+encoden+pushen" — es gibt kein externes
//! gpu-screen-recorder-Binary mehr, das gefunden werden müsste. `has_flv_patch`
//! entfällt (ffmpeg-as-lib muxed Opus in FLV ohne Patch) → `null`.

use anyhow::Result;
use serde_json::{Map, Value, json};

use crate::caps;
use crate::system::{drm, tls};

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    let path = std::env::current_exe()
        .ok()
        .and_then(|p| p.to_str().map(str::to_string));

    // Echte DRM-Vendor-Erkennung (sysfs). Liefert Vendor-Slug + Render-Node.
    let (vendor_slug, available) = match drm::detect() {
        Some((v, _)) => (v.slug(), true),
        None => ("unknown", false),
    };

    let caps = caps::probe();
    let mut gsr = json!({
        "available": available,
        "source": "builtin",
        "is_flatpak": std::path::Path::new("/.flatpak-info").exists(),
        "vendor": vendor_slug,
        "display_server": detect_display_server(),
        // Codecs (Phase 4: echte Open-Probe pro Vendor; aktuell statisch h264+av1).
        "video_codecs": caps.codecs,
        // Zusatzfeld gegenüber Python/win/mac: kann diese Karte 10 bit je
        // Farbkanal encodieren (impliziert AV1)? Ältere Sidecars melden es
        // nicht — Konsumenten müssen `undefined` als false lesen.
        "ten_bit": caps.ten_bit,
        // Zusatzfeld wie `ten_bit`: reicht das gelinkte FFmpeg rollenden
        // Intra-Refresh durch? Auf VAAPI nur mit unserem Patch — ohne ihn
        // verweigert der Encoder-Open den Start. Ältere Sidecars melden das
        // Feld nicht; Konsumenten müssen `undefined` als false lesen.
        "intra_refresh": caps.intra_refresh,
        // Zusatzfeld wie `ten_bit`: kann dieser Rechner HDR SENDEN?
        //
        // Bewusst die **Geraete**-Frage und nicht „laeuft gerade ein Schirm in
        // HDR" — sonst verschwaende die Option spurlos, sobald jemand HDR am
        // Bildschirm ausschaltet, und niemand kaeme darauf, woran es liegt.
        // Ob die konkrete Lage traegt, entscheidet `ops::start` mit einer
        // Meldung, die die Abhilfe nennt.
        //
        // **Was hier NICHT geprueft wird: die Berechtigung.** Die
        // Scanout-Aufnahme braucht CAP_SYS_ADMIN; ob der Sidecar sie hat,
        // zeigt sich erst beim Start. Ein `true` heisst also „die Karte und
        // der Encoder koennen es", nicht „es wird gelingen".
        "hdr": crate::encode::hdr::verfuegbar_hier(&caps.codecs),
        // Das Portal verhandelt Monitor ODER Window (`SourceType` in
        // portal.rs) — "region" hier zu bewerben hieße, einen Modus zu
        // versprechen, der still als Monitor/Window-Dialog endet.
        "capture_options": ["display", "window"],
        // true: ffmpeg-as-lib (FFmpeg 8) muxed Opus→FLV nativ — die
        // Fähigkeit, um die es beim GSR-Patch ging, ist vorhanden. (Null
        // verletzte den typisierten boolean-Kontrakt in gsr.ts.)
        "has_flv_patch": true,
        // Echt aus avformat_configuration() — verrät, ob tls_verify=0 für
        // RTMPS mit self-signed MediaMTX-certs greift (gnutls/openssl: ja).
        "tls_backend": tls::detect(),
    });
    if let Some(p) = path {
        gsr["path"] = Value::String(p);
    }

    let mut out = Map::new();
    out.insert("gsr".to_string(), gsr);
    Ok(out)
}

fn detect_display_server() -> &'static str {
    match std::env::var("XDG_SESSION_TYPE").as_deref() {
        Ok("wayland") => "wayland",
        Ok("x11") => "x11",
        _ => "unknown",
    }
}
