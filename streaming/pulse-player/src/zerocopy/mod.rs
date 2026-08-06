//! Der Weg des dekodierten Bildes von der GPU zum Shader — **ohne** Umweg
//! ueber den Hauptspeicher.
//!
//! Heute nimmt jedes Bild unter Windows den Weg GPU → Hauptspeicher → GPU
//! zurueck: `av_hwframe_transfer_data` legt eine Ablage-Textur an, bildet sie
//! ab und kopiert byteweise ueber unbeschleunigten Speicher (gemessen 3,5 ms
//! bei 1080p8, 5,2-5,5 ms bei 1080p10 — `player-2026-08-06-bildweg-kosten`),
//! danach schiebt `write_texture` dieselben Daten wieder hinauf.
//!
//! ## Warum das hier eine Bruecke ist und kein reines Durchreichen
//!
//! Naheliegend waere, FFmpegs Decoder-Textur selbst zu teilen. Das geht nicht,
//! und zwar aus zwei unabhaengigen Gruenden, die beide gemessen bzw. im
//! Quelltext nachgelesen sind (Messakte
//! `streaming/testbench/profiles/player-2026-08-06-zerocopy-d3d12-amd.json`):
//!
//! * **Der D3D11VA-Decoder liefert nur einen Textur-STAPEL.**
//!   `d3d11va_create_decoder` bricht ohne Array-Textur ab
//!   („AVD3D11VAFramesContext.texture not set.", `libavcodec/dxva2.c:482`), und
//!   `get_surface` prueft jedes Bild gegen genau diese eine Textur (`:761`).
//!   Der frueher empfohlene Ausweg `initial_pool_size = 0` gilt fuer den
//!   ENCODER-Pool des Sidecars, nicht fuer den Decoder.
//! * **Einen geteilten Stapel nimmt D3D12 nicht an.** `OpenSharedHandle` auf
//!   eine NV12/P010-Textur mit `ArraySize > 1` liefert
//!   `DXGI_ERROR_DEVICE_REMOVED` — das Geraet ist danach weg. Nicht abfangbar,
//!   also nicht einmal versuchsweise zu fahren.
//!
//! Deshalb: die Schicht des dekodierten Bildes wird **GPU-intern** in eine
//! eigene, einschichtige, teilbare Textur kopiert
//! (`CopySubresourceRegion` auf FFmpegs eigenem D3D11-Geraet), und DIESE haengt
//! der Renderer in wgpu ein. Kein PCIe-Rueckweg, keine CPU-Kopie — der Umweg
//! wird durch eine Kopie ersetzt, die auf der Kopiereinheit der GPU laeuft.
//! Dieselbe Bruecke faehrt `streaming/win-hq-sidecar/src/capture/wgc_d3d12.rs`
//! seit laengerem in der Gegenrichtung.
//!
//! ## Was der Weg kostet, und warum er nicht die Vorgabe ist
//!
//! **Der Einfrier-Waechter kann auf diesem Weg nicht arbeiten.** Er bildet den
//! Fingerabdruck ueber JEDES Byte des Bildes (`einfrieren::abdruck`, und dass
//! eine Stichprobe nicht genuegt, ist am 2026-08-05 teuer gelernt worden) — das
//! setzt die Ebenen im Hauptspeicher voraus, die es hier gerade nicht mehr
//! gibt. Dasselbe gilt fuer die Latenz-Sonde (`probe`) und `--dump`.
//!
//! Ein stehender Decoder bliebe damit unbemerkt. Deshalb ist Zero-Copy
//! **ausdruecklich anzufordern** (`PULSE_PLAYER_ZEROCOPY=1`) und nicht die
//! Vorgabe: eine Zeitersparnis von wenigen Millisekunden wiegt einen
//! ausgefallenen Waechter nicht auf. Wer den Weg fuer die Vorgabe halten will,
//! muss den Abdruck vorher auf die GPU holen.

#[cfg(windows)]
mod bruecke;
#[cfg(windows)]
mod ffmpeg_geraet;
#[cfg(windows)]
mod platz;
#[cfg(windows)]
pub use bruecke::Bruecke;
#[cfg(windows)]
pub use platz::GpuBild;

#[cfg(not(windows))]
mod leer;
#[cfg(not(windows))]
pub use leer::{Bruecke, GpuBild};

mod uebergabe;
pub use uebergabe::bild_ohne_umweg;

/// Ist der Weg angefordert?
///
/// Vorgabe aus, Begruendung im Modulkopf. Bewusst eine Umgebungsvariable und
/// kein Sitzungsschalter: der Weg ist ein Messinstrument, solange der
/// Einfrier-Waechter darauf nicht arbeitet, und Messinstrumente stehen in
/// diesem Player durchgehend in der Umgebung (`PULSE_PLAYER_SURFACE`,
/// `PULSE_PLAYER_BACKEND`, `PULSE_PLAYER_PRESENT_MODE`).
pub fn angefordert() -> bool {
    matches!(std::env::var("PULSE_PLAYER_ZEROCOPY").as_deref().map(str::trim), Ok("1"))
}
