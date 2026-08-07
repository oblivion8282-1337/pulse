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
//!
//! ## ZWILLING — wer hier etwas lernt, muss es dort nachtragen
//!
//! `streaming/win-hq-sidecar/src/capture/wgc_d3d12.rs` faehrt dieselbe Bruecke
//! in der Gegenrichtung, und zwar strukturgleich: Ring teilbarer Texturen,
//! `SHARED_NTHANDLE|KEYEDMUTEX`, `ID3D11Fence` samt CPU-Warten, Handles im
//! `Drop` geschlossen. **Es sind zwei getrennte Crates ohne gemeinsame
//! Bibliothek** — bewusst nicht geteilt, aus demselben Grund wie bei
//! `render::hdr_fenster::schirm_kann_hdr` (eine Bibliothek dafuer waere mehr
//! Kopplung als die Zeilen wert sind).
//!
//! Der Preis dafuer ist diese Notiz. Am 2026-08-06 waren die beiden bereits
//! auseinandergelaufen: der Sidecar hatte `Flush()` und das Ueberspringen des
//! Wartens bei bereits erreichtem Zaunwert, diese Seite nicht. **Sollte je ein
//! dritter Verbraucher dazukommen oder der warteschlangenseitige Zaun
//! (`ID3D12Fence::Wait`, auf wgpu 29 nicht erreichbar) gebaut werden, ist das
//! der Zeitpunkt, eine gemeinsame Crate anzulegen** — jene Aenderung muss
//! ohnehin in beide Dateien.
//!
//! ## Wer auf diesem Weg noch mitliest — und wer nicht mehr
//!
//! **Hier stand bis zum 2026-08-06 „Der Einfrier-Waechter kann auf diesem Weg
//! nicht arbeiten" und, daraus gefolgert, „deshalb ist Zero-Copy ausdruecklich
//! anzufordern (`PULSE_PLAYER_ZEROCOPY=1`) und nicht die Vorgabe". Beides ist
//! ueberholt.** Der Waechter bildet seinen Fingerabdruck seither auf der GPU
//! (`render::abdruck`, Rechenvorschrift in `einfrieren::gpuabdruck`): ein
//! Durchgang ueber die Luma-Ebene der eingehaengten Textur, angefordert je Bild
//! und ein bis zwei Bilder spaeter abgeholt, ohne auf die GPU zu warten. Der
//! Grund fuer die Sonderstellung des Weges ist damit weg, und
//! [`angefordert`] ist umgedreht: **Zero-Copy ist die Vorgabe,
//! `PULSE_PLAYER_ZEROCOPY=0` schaltet ihn AUS.**
//!
//! Was weiterhin gilt:
//!
//! * **Die Latenz-Sonde (`probe`) misst auf diesem Weg nicht.** Sie liest ein
//!   gemaltes Muster aus der Luma-Ebene im Hauptspeicher. Sie ist ein
//!   Messwerkzeug und kein Betriebsteil, darf also ausfallen — aber sie SAGT es
//!   jetzt, einmal und deutlich, statt stumm nichts zu liefern. Wer sie
//!   braucht, setzt `PULSE_PLAYER_ZEROCOPY=0`.
//! * **Bleibt der Abdruck aus, gibt der Decoder den Weg auf.** Rechnet der
//!   Renderer nicht (Bindung abgelehnt, Fenster zeichnet nicht mehr), saehe der
//!   Waechter sonst gar kein Bild — dieselbe Luecke, nur leiser. Der Zulauf
//!   (`einfrieren::Zulauf`) zaehlt unbeantwortete Bilder mit und loest
//!   [`abschalten`] aus.
//!
//! **Hier stand zusaetzlich „und `--dump`". Das ist falsch**, und es stand am
//! 2026-08-06 gleich an drei Stellen so: einen Schalter `--dump` gibt es nicht,
//! der Mitschnitt haengt an `PULSE_PLAYER_DUMP_RTP` und schreibt **RTP-Pakete**
//! (`session.rs`, `dump.rs`) — er beruehrt `DecodedFrame` ueberhaupt nicht und
//! laeuft auf diesem Weg unveraendert weiter.

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

/// Gibt es fuer dieses Pixelformat auf DIESER Plattform eine Bruecke?
///
/// **Die Abfrage gehoert hierher und nicht in `decode.rs`.** Dort stand sie bis
/// zum 2026-08-07 als `format == Pixel::D3D11`, also mit der Antwort einer
/// einzigen Plattform fest verdrahtet — wer eine zweite Bruecke ergaenzt, muss
/// sonst zwei Dateien treffen und merkt beim Vergessen der zweiten nichts:
/// der Decoder liefert weiter GPU-Bilder, die Bruecke wird nur nie gefragt, und
/// es faellt allein als ausgebliebene Ersparnis auf.
///
/// Der `#[cfg]` steht hier, weil `Pixel::D3D11` und `Pixel::CUDA` beide auf
/// jeder Plattform existieren — ein plattformloser `matches!` wuerde unter
/// Linux nach D3D11 fragen und die Bruecke bauen lassen, die es dort nicht gibt.
pub fn bruecke_moeglich(format: ffmpeg_next::format::Pixel) -> bool {
    #[cfg(windows)]
    {
        format == ffmpeg_next::format::Pixel::D3D11
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        format == ffmpeg_next::format::Pixel::CUDA
    }
    #[cfg(target_os = "macos")]
    {
        let _ = format;
        false
    }
}

/// Der Schalter, EINMAL aus der Umgebung gelesen.
///
/// **Nicht je Bild.** `std::env::var` geht unter Windows ueber
/// `GetEnvironmentVariableW`, holt sich die prozessweite Sperre und
/// allokiert zweimal (UTF-16-Puffer plus Umwandlung). Bei 60 Bildern je Sekunde
/// ist das umsonst — der Wert kann sich zur Laufzeit ohnehin nicht aendern.
///
/// `AtomicBool` und nicht `bool`, weil der Renderer ihn LOESCHEN koennen muss
/// (s. [`abschalten`]).
///
/// **Die Abfrage ist am 2026-08-06 umgedreht worden** — vorher `Ok("1")` schaltet
/// EIN, jetzt `Ok("0")` schaltet AUS. Begruendung im Modulkopf: der einzige
/// Grund fuer die Sonderstellung war der ausgefallene Einfrier-Waechter, und
/// den gibt es nicht mehr.
fn schalter() -> &'static std::sync::atomic::AtomicBool {
    static AN: std::sync::OnceLock<std::sync::atomic::AtomicBool> = std::sync::OnceLock::new();
    AN.get_or_init(|| {
        let aus = matches!(
            std::env::var("PULSE_PLAYER_ZEROCOPY").as_deref().map(str::trim),
            Ok("0")
        );
        std::sync::atomic::AtomicBool::new(!aus)
    })
}

/// Laeuft der Weg — Vorgabe ja, und noch nicht aufgegeben?
///
/// Bewusst eine Umgebungsvariable und kein Sitzungsschalter: was hier
/// abzuschalten waere, schaltet man zum Messen ab (Latenz-Sonde, Vergleich
/// gegen das Ruecklesen), und solche Schalter stehen in diesem Player
/// durchgehend in der Umgebung (`PULSE_PLAYER_SURFACE`,
/// `PULSE_PLAYER_BACKEND`, `PULSE_PLAYER_PRESENT_MODE`).
///
/// Der Name ist geblieben, obwohl er jetzt weniger passt: er steht an einem
/// Dutzend Stellen, und „laeuft" haette denselben Inhalt.
pub fn angefordert() -> bool {
    schalter().load(std::sync::atomic::Ordering::Relaxed)
}

/// Den Weg abschalten — der Decoder holt die Bilder ab jetzt wieder herunter.
///
/// **Das ist der Rueckkanal vom Renderer zum Decoder, und ohne ihn fehlte der
/// einzige Fehlerfall, den niemand bemerkt.** Kann der Renderer eine
/// Fremdtextur nicht einhaengen (anderer Adapter unter FFmpeg als unter wgpu,
/// anderes Backend, fehlendes Merkmal), dann liefert der Decoder weiter
/// GPU-Bilder, die der Renderer allesamt auslaesst: ein schwarzes Fenster bei
/// 0 Bildern je Sekunde.
///
/// **Hier stand bis zum 2026-08-06 „und weil auf diesem Weg auch der
/// Einfrier-Waechter nicht arbeitet, meldet es nichts und niemand". Das ist
/// falsch, seit der Abdruck auf der GPU entsteht** — bliebe er aus, gaebe der
/// Decoder den Weg von sich aus auf (`einfrieren::Zulauf`). Dieser Rueckkanal
/// bleibt trotzdem der bessere: er greift beim ERSTEN Bild und nennt die
/// Ursache, wo der Zulauf fuenf Sekunden braucht und nur die Wirkung sieht.
///
/// Die Gruende sind alle bleibend, deshalb wird nicht erneut versucht. Die
/// Meldung kommt genau einmal.
pub fn abschalten(grund: &str) {
    if schalter().swap(false, std::sync::atomic::Ordering::Relaxed) {
        eprintln!("pulse-player: Zero-Copy abgeschaltet ({grund}) — wieder Ruecklesen");
    }
}
