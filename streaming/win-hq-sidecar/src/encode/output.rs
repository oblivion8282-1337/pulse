//! Output-Kontext: Push-URL öffnen, Muxer-Verhalten setzen, Encoder-Optionen prüfen.
//!
//! Gemeinsame Stelle für alle drei Encoder-Pfade (CPU / NVENC-D3D11 /
//! AMD-D3D12). Lag bis 2026-07-30 in `encoder.rs`; herausgezogen, weil die
//! Begründungen zu `max_interleave_delta` und `tcp_nodelay` dort den
//! Encoder-Code zugestellt hätten (und die Datei schon an der Größen-Grenze
//! stand).

use anyhow::{Context, Result, anyhow};
use ffmpeg_next as ffmpeg;
use ffmpeg::{Dictionary, codec, format};

/// Wartezeit des Muxer-Interleavers in Mikrosekunden (`max_interleave_delta`).
///
/// **Bilder dürfen nicht auf den Ton warten.** `av_interleaved_write_frame`
/// puffert absichtlich, um die Spuren in DTS-Reihenfolge auszugeben: ein
/// Videopaket bleibt liegen, bis Ton mit passendem Zeitstempel vorliegt. Ohne
/// Deckel wartet jedes Bild den Rückstand des Tons mit — der Rückstand ist
/// damit 1:1 Bild-Latenz.
///
/// Übernommen vom Linux-Sidecar, wo der Wert gemessen ist (2026-07-27,
/// `streaming/linux-hq-sidecar/src/encode/mod.rs::DEFAULT_INTERLEAVE_US`):
/// Ende zu Ende 99,8 → 82,3 ms bei 60 fps, bei jeder Bildrate besser. **Auf
/// Windows ist die Wirkung noch ungemessen** — der Muxer-Weg ist derselbe
/// (FLV, `write_interleaved`, zwei Spuren), die Zahl aber nicht übertragbar.
///
/// **Der Wert hat eine Untergrenze, und die ist scharf:** FLV ist EINE
/// Tag-Zeitleiste, die Zeitstempel müssen über beide Spuren aufsteigen. Wird
/// ein Bild sofort geschrieben und trifft danach ein älteres Tonpaket ein,
/// lehnt der Muxer es ab (`write_interleaved: Invalid argument`) und der Stream
/// stirbt. Auf Linux gemessen: Delta 1 µs starb sofort, Delta 2 ms lief bei
/// 144 fps und starb bei 280 fps. 10 ms hält Abstand zu dieser Kante, und
/// darunter (3 ms, 1 ms) brachte es bei 60 fps nichts mehr.
///
/// **Der Deckel gilt erst, wenn beide Spuren laufen** — gesetzt wird er deshalb
/// nicht hier, sondern vom `MuxWriter`, sobald er von jeder Spur ein Paket
/// gesehen hat. Beim Start ist genau das der Unterschied: solange nur Bild
/// anliegt, wartet der Muxer mit dem ffmpeg-Vorgabewert (10 s) auf den Ton.
/// Mit dem engen Deckel ab der ersten Sekunde gab er stattdessen nach 10 ms
/// Bilder frei, und das erste Tonpaket kam damit zu spaet — der Stream starb
/// beim Start (2026-07-30 gegen die Produktion gemessen:
/// „Packets are not in the proper order with respect to DTS", 6 ms nach `live`).
///
/// Über `PULSE_MUX_INTERLEAVE_US` veränderbar, damit der Kompromiss messbar
/// bleibt statt geraten zu werden.
const DEFAULT_INTERLEAVE_US: i64 = 10_000;

/// Der Deckel aus der Umgebung, sonst [`DEFAULT_INTERLEAVE_US`]. Der `MuxWriter`
/// setzt ihn, sobald jede Spur geliefert hat.
pub fn interleave_delta_us() -> i64 {
    std::env::var("PULSE_MUX_INTERLEAVE_US")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|v| *v > 0)
        .unwrap_or(DEFAULT_INTERLEAVE_US)
}

/// Für URL-Schemes ohne Extension wählt FFmpegs Auto-Detect kein Format —
/// wir mappen die unterstützten Streaming-Protokolle hier explizit.
///
/// - `rtmp://` / `rtmps://` → FLV (RTMP transportiert FLV-Tags)
/// - `srt://` → MPEG-TS (SRT-Standard)
/// - `http(s)://` → WHIP (WebRTC-Ingest; media-svc mintet solche URLs für
///   Gäste auf App-gehosteten Instanzen)
/// - Sonst → `None` (FFmpeg-Default, Extension-basiert)
pub fn url_format_hint(target: &str) -> Option<&'static str> {
    let lower = target.to_ascii_lowercase();
    if lower.starts_with("rtmp://") || lower.starts_with("rtmps://") {
        Some("flv")
    } else if lower.starts_with("srt://") {
        Some("mpegts")
    } else if lower.starts_with("http://") || lower.starts_with("https://") {
        Some("whip")
    } else {
        None
    }
}

/// Ist das eine WHIP-URL (WebRTC-Ingest)? Die Antwort kommt aus derselben
/// Schema-Tabelle wie die Muxer-Wahl — es darf nirgends eine zweite geben.
///
/// Gleicher Dreizeiler wie `linux-hq-sidecar::encode::is_whip_url`. Ohne ihn
/// schreibt jeder Aufrufer `url_format_hint(..) == Some("whip")` selbst aus,
/// und spätestens der dritte schreibt es leicht anders. Was daran hängt, ist
/// nicht kosmetisch: greift eine Kopie zu weit, landet ein RTMPS-Stream im
/// WebRTC-Sender; greift sie zu kurz, läuft ein WHIP-Stream still über den
/// ffmpeg-Muxer — und genau diese Verwechslung hat auf der Linux-Seite am
/// 2026-07-30 eine ganze Messreihe entwertet.
pub fn is_whip_url(url: &str) -> bool {
    url_format_hint(url) == Some("whip")
}

/// Öffnet den Output-Kontext für die Push-URL.
///
/// Für RTMPS: `tls_verify=0` — Pulse-MediaMTX nutzt by-design ein self-signed
/// Cert; die echte Auth läuft per Stream-Token in der URL → authHTTP-Hook.
/// FFmpegs Schannel-Backend ist strict-verify by default und killt den Stream
/// sonst nach dem TLS-Handshake. `rw_timeout` (µs): ohne das blockiert ein
/// toter Connect/Write den Worker unbegrenzt → Sidecar-Freeze bei `stop()`.
///
/// Für WHIP: der Muxer macht sein eigenes I/O (ICE/DTLS/SRTP) — die
/// AVIO-Optionen greifen dort nicht; stattdessen den Handshake begrenzen.
/// Vorab-Probe, damit ein FFmpeg ohne WHIP-Muxer (braucht DTLS/OpenSSL im
/// Build) eine klare Meldung liefert statt eines kryptischen Open-Fehlers.
pub fn open_output(output_path: &str) -> Result<format::context::Output> {
    // **Ein angemeldeter Sendeweg darf nicht umgangen werden.** Nur
    // `encoder_hw` kennt die Gabelung; `encoder` (CPU) und `encoder_d3d12`
    // landen sonst hier und muxen an ihm vorbei. Das Ergebnis wäre ein Stream,
    // der über den ffmpeg-WHIP-Muxer geht — der auf Windows an DTLS scheitert
    // und selbst wenn er liefe, kein AV1 könnte und keinen Rückkanal hätte.
    // Lieber laut absagen als still das Falsche tun: eine Messung unter
    // falschem Etikett ist teurer als ein abgebrochener Start.
    if super::senke::zustaendig(output_path) {
        return Err(anyhow!(
            "dieser Encode-Weg kann den angemeldeten Sendeweg nicht bedienen (nur der \
             D3D11-Weg ist gegabelt) — Stream abgebrochen statt still ueber den Muxer"
        ));
    }
    match url_format_hint(output_path) {
        Some(fmt) => {
            let mut opts = Dictionary::new();
            if fmt == "whip" {
                ensure_muxer_available(fmt)?;
                opts.set("handshake_timeout", "10000");
            } else {
                opts.set("rw_timeout", "10000000");
                // Nagle abschalten. Ohne das sammelt der Kernel kleine
                // Schreibvorgänge und wartet auf die Bestätigung des vorherigen
                // Pakets — zusammen mit verzögerten Bestätigungen der Gegenseite
                // eine feste Verzögerung von bis zu 40 ms, die NICHT an der
                // Datenmenge hängt. Auf Linux mit 3,6 ms gemessen; hier
                // ungemessen, aber derselbe Socket und dieselbe Mechanik.
                // Über `PULSE_TCP_NODELAY=0` abschaltbar (Vergleichsmessung).
                if crate::env::flag_default_on("PULSE_TCP_NODELAY") {
                    opts.set("tcp_nodelay", "1");
                }
                if output_path.to_ascii_lowercase().starts_with("rtmps://") {
                    opts.set("tls_verify", "0");
                }
            }
            format::output_as_with(&output_path, fmt, opts)
                .with_context(|| format!("format::output_as_with({output_path}, {fmt})"))
        }
        None => format::output(&output_path)
            .with_context(|| format!("format::output({output_path})")),
    }
}

/// Zusaetzliche Encoder-Optionen aus `PULSE_ENCODER_OPTS`, Form
/// `"async_depth=1,usage=ultralowlatency"`. Ueberschreibt die Vorgaben der
/// Vendor-Zweige.
///
/// **Wofuer das da ist:** eine Encoder-Einstellung zu vergleichen hiess bisher,
/// den Wert im Quelltext zu aendern und neu zu bauen — das macht nach der
/// dritten Variante niemand mehr, und genau daran haengt die offene Arbeit auf
/// dem AMD-Zweig (`async_depth`, `usage`). Mit dieser Variable faehrt ein
/// Messlauf eine ganze Reihe an einem Stueck, und ein Rueckschalter auf den
/// alten Stand braucht keinen eigenen Schalter mehr.
///
/// Die WERTE werden nicht geprueft — wer hier Unsinn setzt, misst Unsinn. Die
/// SCHLUESSEL dagegen schon: [`warn_unknown_opts`] meldet vor dem Open jeden,
/// den der Encoder nicht kennt. Ohne das waere eine wirkungslose Messvariante
/// von einer wirksamen nicht zu unterscheiden.
pub fn apply_encoder_opts_override(opts: &mut Dictionary<'_>) {
    let Ok(roh) = std::env::var("PULSE_ENCODER_OPTS") else {
        return;
    };
    for paar in roh.split(',') {
        let Some((k, v)) = paar.split_once('=') else {
            continue;
        };
        let (k, v) = (k.trim(), v.trim());
        if k.is_empty() {
            continue;
        }
        eprintln!("[encode] PULSE_ENCODER_OPTS: {k}={v}");
        opts.set(k, v);
    }
}

/// Meldet Encoder-Optionen, die dieser Encoder gar nicht kennt.
///
/// **Warum das nötig ist:** `avcodec_open2` bekommt die Optionen als `av_dict`.
/// Was es nicht zuordnen kann, bleibt im Dictionary liegen und wird beim
/// Aufräumen verworfen — **ohne eine einzige Logzeile**. Die ffmpeg-CLI meldet
/// Unbekanntes, weil sie den Rest hinterher selbst prüft; über die Bibliothek
/// passiert das nicht, und `open_with` prüft es auch nicht.
///
/// Das ist die Fehlerform, an der eine Messreihe scheitert, ohne es zu zeigen:
/// eine Option, die dieser Encoder nicht hat, wirkt nicht — der Lauf sieht aber
/// normal aus, und die Zahl wird als Ergebnis gedeutet. Auf Linux hat dieselbe
/// Prüfung sofort einen Fund geliefert (`coder=cabac` stand unbedingt in beiden
/// Vendor-Zweigen, existiert bei AV1 aber nicht).
///
/// `AV_OPT_SEARCH_CHILDREN` erfasst neben den generischen
/// `AVCodecContext`-Optionen auch die privaten des Encoders.
///
/// Nur eine Warnung, kein Fehler: [`super::encoder::vendor_encoder_opts`]
/// erzeugt seit 2026-07-30 keinen unbekannten Schlüssel mehr, die verbleibende
/// Quelle wäre eine künftige Ergänzung — die soll auffallen, aber niemanden am
/// Streamen hindern.
///
/// Nimmt den Encoder als `&mut`, nicht als Rohzeiger: damit hält der Kontrakt
/// (gültiger, den Aufruf überlebender `AVCodecContext`) am Typ statt in drei
/// gleichlautenden SAFETY-Kommentaren an den Aufrufstellen. Aufzurufen VOR
/// `open_with` — danach ist die Optionstabelle bereits abgearbeitet.
pub fn warn_unknown_opts(
    encoder: &mut codec::encoder::video::Video,
    encoder_name: &str,
    opts: &Dictionary<'_>,
) {
    // SAFETY: nur den Zeiger holen; der `&mut`-Borrow hält den Kontext für die
    // ganze Funktion am Leben und exklusiv.
    let ctx = unsafe { encoder.as_mut_ptr() };
    for (key, value) in opts.iter() {
        // Kein gültiger C-String (eingebettetes NUL-Byte) → derselbe
        // Frühausstieg wie zuvor inline: kein Fund, aber auch keine Warnung —
        // das ist ein Schlüssel, den wir gar nicht erst prüfen konnten, nicht
        // einer, den der Encoder nachweislich nicht kennt.
        if std::ffi::CString::new(key).is_err() {
            continue;
        }
        // SAFETY: `ctx` stammt aus dem `&mut`-Borrow oben, ist also gültig und
        // lebt über den Aufruf hinaus.
        if !unsafe { has_option(ctx, key) } {
            eprintln!(
                "[encode] WARNUNG: '{encoder_name}' kennt die Option '{key}={value}' nicht — \
                 ffmpeg verwirft sie still, sie wirkt NICHT"
            );
        }
    }
}

/// Kennt dieser Encoder-Kontext die Option `name`? Gemeinsame Stelle für den
/// `av_opt_find`-Probe — stand vorher wortgleich hier UND in
/// `auffrischung.rs::kennt_option`, die jetzt hierher delegiert.
///
/// # Safety
///
/// `ctx` muss ein gültiger `AVCodecContext` sein und den Aufruf überleben.
/// Die Funktion liest ihn nur.
pub(super) unsafe fn has_option(ctx: *mut ffmpeg::ffi::AVCodecContext, name: &str) -> bool {
    let Ok(name) = std::ffi::CString::new(name) else {
        return false;
    };
    // SAFETY: Kontrakt der Funktion; `name` lebt bis zum Ende des Aufrufs.
    let gefunden = unsafe {
        ffmpeg::ffi::av_opt_find(
            ctx.cast(),
            name.as_ptr(),
            std::ptr::null(),
            0,
            ffmpeg::ffi::AV_OPT_SEARCH_CHILDREN,
        )
    };
    !gefunden.is_null()
}

/// Probe: trägt das gelinkte FFmpeg den Muxer überhaupt? (WHIP existiert nur
/// in Builds mit DTLS-Support, FFmpeg ≥ 8.0 + OpenSSL.)
fn ensure_muxer_available(fmt: &'static str) -> Result<()> {
    let name = std::ffi::CString::new(fmt).expect("static fmt name");
    let found = unsafe {
        !ffmpeg::ffi::av_guess_format(name.as_ptr(), std::ptr::null(), std::ptr::null()).is_null()
    };
    if found {
        Ok(())
    } else {
        Err(anyhow::anyhow!(
            "Muxer '{fmt}' fehlt im gelinkten FFmpeg — für WHIP wird FFmpeg ≥ 8.0 \
             mit DTLS (OpenSSL) benötigt. Bitte FFmpeg-DLLs aktualisieren."
        ))
    }
}
