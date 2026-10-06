//! TLS-De-Risk: öffnet einen RTMPS-Output-Context mit `tls_verify=0` gegen
//! ein MediaMTX mit self-signed Cert und reportiert Backend + Handshake-Ergebnis.
//!
//! Das ist die offene Verschlüsselungs-Frage: macOS braucht einen eigenen
//! OpenSSL-FFmpeg-Build (SecureTransport blockt RTMPS-Bulk-Writes). Auf Linux
//! mit GnuTLS im System-FFmpeg sollte `tls_verify=0` out-of-the-box greifen —
//! dieser Probe beweist das.
//!
//! ```text
//! cargo run --release --example tls_probe -- rtmps://localhost:11936/test
//! ```
//! Vorab: `docker compose -f test/docker-compose.yml up -d`.

use ffmpeg_next as ffmpeg;
use ffmpeg::{Dictionary, format};

use pulse_linux_hq_sidecar::system::tls;

fn main() -> anyhow::Result<()> {
    let _ = ffmpeg::init();

    let url = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "rtmps://localhost:11936/test".to_string());

    // 1) TLS-Backend aus avformat_configuration() — dieselbe Erkennung wie im
    //    `health`-Report (`system::tls::detect`).
    let backend = tls::detect();
    eprintln!("[tls_probe] FFmpeg TLS backend: {:?}", backend);
    eprintln!("[tls_probe] opening output: {url}");

    // 2) Output-Context mit tls_verify=0 + rw_timeout (10s).
    //    `output_as_with` macht: TCP-Connect → TLS-Handshake (tls_verify=0
    //    akzeptiert das self-signed Cert) → RTMP-Handshake. Gelingt das, ist
    //    die Verschlüsselungs-Frage beantwortet.
    let mut opts = Dictionary::new();
    opts.set("rw_timeout", "10000000"); // 10s — sonst blockt ein toter Socket ewig
    if url.starts_with("rtmps://") {
        opts.set("tls_verify", "0");
    }
    let fmt = if url.starts_with("rtmp") {
        "flv"
    } else if url.starts_with("srt") {
        "mpegts"
    } else {
        ""
    };

    let octx = if fmt.is_empty() {
        format::output(&url)?
    } else {
        format::output_as_with(&url, fmt, opts)?
    };
    eprintln!("[tls_probe] ✅ output context opened — TCP+TLS-Handshake (tls_verify=0) + RTMP-Handshake erfolgreich");

    // Öffnen allein macht schon den vollen RTMP-Connect (createStream). Ein
    // richtiger Publish braucht write_header + Streams — das kommt in Phase 5
    // (encode-Pipeline). Für den TLS-De-Risk reicht der geöffnete Context.
    drop(octx);
    eprintln!("[tls_probe] context geschlossen.");

    eprintln!("[tls_probe] ERGEBNIS: RTMPS-Connect mit self-signed Cert funktioniert (backend={:?}).", backend);
    Ok(())
}
