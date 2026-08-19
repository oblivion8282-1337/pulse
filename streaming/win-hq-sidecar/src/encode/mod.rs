//! Encode-Pipeline.
//!
//! Drei Pfade, gewählt nach Adapter UND Codec (`stream_controller::run_pipeline`):
//!
//! - **D3D11-Zero-Copy** (`encoder_hw.rs` + `hwctx.rs`) — NVIDIA mit jedem
//!   Codec, AMD mit AV1. WGC liefert D3D11-BGRA-Texturen, wir kopieren sie
//!   GPU-intern in einen D3D11VA-Pool (`av_hwframe_get_buffer`); `h264_nvenc`
//!   bzw. `av1_amf` liest BGRA direkt und macht den NV12-Convert selbst.
//!   Downscale über `d3d11_scale.rs` (`ID3D11VideoProcessor`), auch auf der GPU.
//! - **D3D12-Zero-Copy** (`encoder_d3d12.rs` + `d3d12_convert.rs`) — AMD mit
//!   H.264/HEVC. Nativer `h264_d3d12va` über die D3D12 Video Encode API,
//!   BGRA→NV12 per Compute-Shader.
//! - **CPU-Fallback** (`encoder.rs`) — Intel (QSV), und für jeden Vendor unter
//!   `PULSE_HQ_DISABLE_ZERO_COPY=1`. swscale BGRA→NV12 auf der CPU; bei
//!   1440p→1080p60 kostete das gemessen eine volle CPU-Kerne, es ist also
//!   wirklich nur ein Notausgang.
//!
//! Kein Pfad hat einen PCIe-Roundtrip außer dem CPU-Fallback.

pub mod audio;
pub mod auffrischung;
pub mod bildencoder;
pub mod codec;
pub mod d3d11_scale;
pub mod d3d12_convert;
mod d3d12_device;
mod einmal;
pub mod encoder;
pub mod farbraum;
pub mod hdr;
mod hdr_ansichten;
pub mod hdr_metadaten;
pub mod hdr_wandler;
pub mod hdr_zeichner;
mod fail_slot;
pub mod encoder_d3d12;
pub mod extradata;
pub mod encoder_hw;
pub mod hwctx;
pub mod latency;
pub mod mux_writer;
pub mod opts;
pub mod output;
pub mod senke;
pub mod senke_writer;
pub mod zehnbit;

/// **`rc_buffer_size` (VBV) wurde probiert und wirkt auf keinem AMD-Zweig** —
/// nicht eingebaut, damit es niemand ein zweites Mal versucht.
///
/// Naheliegender Verdacht bei schwankender Bitrate: wir setzen `bit_rate` und
/// `max_bit_rate`, aber nie das Fenster, über das der Mittelwert gelten soll.
/// Am 2026-07-30 auf einer Radeon 780M nachgemessen (Sekundenwerte aus den
/// Paketgrößen, Ziel 4000 kbps):
///
/// | | Spanne max/min |
/// |---|---|
/// | `av1_amf` ohne VBV | x2,32 |
/// | `av1_amf` mit VBV (1 s) | x2,32 |
/// | `h264_d3d12va` ohne / mit VBV | x1,23 / x1,23 (byte-gleich) |
///
/// Beide Encoder ignorieren das Feld. Die Schwankung von `av1_amf` ist eine
/// Eigenschaft seiner Ratensteuerung; eng bekommt man sie nur mit
/// `filler_data=1` — und das erzeugt `OBU_PADDING` von 0,4 bis 8,3 kB, also
/// genau die Bitstromform, die `infra/mediamtx-fork/` wegpatcht, weil sie
/// libwebrtcs RTP-Zusammenbau zerlegt. Kein Weg.
///
/// Meldet, WELCHER Encoder wirklich offen ist — von allen drei Encoder-Pfaden
/// direkt nach `open_with` gerufen.
///
/// Die argv-Zeile der `start`-Antwort meldet den GEWUENSCHTEN Codec; bis dahin
/// koennen zwei Ruecknahmen dazwischengekommen sein (WHIP traegt nur H.264;
/// AV1 verlaesst den d3d12va-Pfad mangels extradata). Ohne diese Zeile stand
/// nirgends, was am Ende lief — und eine Messung unter falschem Etikett sieht
/// vollkommen plausibel aus.
/// **Bittiefe und Betriebsart gehoeren dazu, und zwar aus demselben Grund wie
/// der Encoder-Name.** Ein 10-bit-Wunsch, dessen Encode-Weg es strukturell
/// nicht kann (CPU/D3D12), bricht seit `encode::zehnbit::pruefen` schon VOR
/// diesem Punkt ab — bis hierher kommen nur noch die feineren Ruecknahmen
/// INNERHALB des D3D11-Zero-Copy-Wegs: ein Codec, der 10 bit gar nicht traegt
/// (nur AV1), oder ein angemeldeter Encode-Weg, der einen 8-bit-Pool verlangt
/// (`bildencoder::pool_wahl`, eigene Log-Zeile in `pipeline_hw::run`). Die
/// Auffrischung haengt unveraendert am Encoder. Ohne diese Zeile
/// stand nirgends, was am Ende wirklich lief — und beim ersten
/// 10-bit-Fehlversuch am 2026-08-04 war genau das die Luecke: das Log meldete
/// `av1_amf`, aber nicht, ob der Strom 8 oder 10 bit trug. Damit war nicht zu
/// entscheiden, ob der Fehler beim Sender oder beim Zuschauer lag.
pub fn log_encoder_open(
    codec_name: &str,
    vendor: &str,
    width: u32,
    height: u32,
    fps: u32,
    bitrate_kbps: u32,
    ten_bit: bool,
) {
    let tiefe = if ten_bit { 10 } else { 8 };
    // Drei Zustaende, nicht zwei. Der dritte ist seit dem 2026-08-19 der
    // Regelfall auf `h264_amf`: Vollbilder sind verlangt, der Encoder liefert
    // den bestellten Takt aber nicht von sich aus, also kommen sie aus dem
    // Selbsttakt. Das gehoert in die Zeile — sie ist die Stelle, an der man
    // nachsieht, was wirklich lief.
    //
    // **Hier stand am 2026-08-19 zwischenzeitlich „Vollbilder selbst getaktet,
    // Auffrischung laeuft mit". Das war zu viel behauptet und ist noch am
    // selben Tag zurueckgenommen worden.** Gemessen ist, DASS die sparsame
    // Betriebsart den bestellten Vollbild-Takt unterdrueckt (1 Vollbild statt
    // des bestellten Takts). NICHT gemessen ist, dass sie ihn durch eine
    // rollende Auffrischung ersetzt: im Bitstrom findet sich in dieser
    // Betriebsart keine Spur davon (weder `constrained_intra_pred_flag` noch
    // ein recovery point — und zwar in der ausdruecklich eingeschalteten
    // Auffrischung genauso wenig, die Suche taugt hier also nicht), und ein
    // Schadenstest ueber neun Schnittstellen trennte die beiden Betriebsarten
    // nicht (4 von 9 erholt auf beiden Seiten). Der Nutzer sieht den
    // Auffrischungs-Wischer ausserdem nur bei ausdruecklich eingeschalteter
    // Auffrischung, nicht hier — was gegen die Behauptung spricht.
    //
    // Die Zeile sagt deshalb nur noch, was sie belegen kann.
    let auffrischung = if auffrischung::gewuenscht() {
        "Intra-Refresh"
    } else if auffrischung::braucht_selbsttakt(codec_name) {
        "Vollbilder selbst getaktet"
    } else {
        "Vollbilder"
    };
    eprintln!(
        "[encode] Encoder offen: {codec_name} (vendor={vendor}, {width}x{height}@{fps}, \
         {bitrate_kbps} kbps, {tiefe} bit, {auffrischung})"
    );
}

pub use codec::{EncodePath, VideoCodec};
pub use d3d11_scale::D3D11Scaler;
pub use encoder::{AudioStreamConfig, EncoderConfig, FfmpegEncoder};
pub use encoder_d3d12::{D3d12EncoderConfig, FfmpegD3d12Encoder};
pub use encoder_hw::{FfmpegHwEncoder, HwEncoderConfig};
pub use hwctx::{HwContext, HwPoolConfig, OwnedHwFrame};
pub use bildencoder::{
    BildEncoder, EncoderAuftrag, EncoderBauer, registriere_encoder_bauer,
};
pub use senke::{PaketSenke, SenkenAuftrag, SenkenBauer, registriere_senken_bauer};
