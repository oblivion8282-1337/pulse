//! Der Weg des dekodierten Bildes von der GPU zum Shader — **ohne** Umweg
//! ueber den Hauptspeicher.
//!
//! Ohne diesen Weg nimmt jedes Bild die Strecke GPU → Hauptspeicher → GPU
//! zurueck: `av_hwframe_transfer_data` legt eine Ablage-Textur an, bildet sie
//! ab und kopiert byteweise ueber unbeschleunigten Speicher (gemessen 3,5 ms
//! bei 1080p8, 5,2-5,5 ms bei 1080p10 — `player-2026-08-06-bildweg-kosten`),
//! danach schiebt `write_texture` dieselben Daten wieder hinauf.
//!
//! ## Drei Bruecken, ein Verhalten
//!
//! | | Windows | Linux/NVIDIA | Linux/AMD+Intel |
//! |---|---|---|---|
//! | Decoder | D3D11VA | `av1_cuvid`/`h264_cuvid` mit CUDA-Geraet | nativ mit VAAPI-Geraet |
//! | Uebergabe | geteilte Textur, NT-Handle | exportiertes `VkImage`, Dateideskriptor | DMA-BUF der Decoder-Surface |
//! | Wer legt das Ziel an | FFmpegs D3D11-Geraet | **wgpus** Vulkan-Geraet | niemand — es wird nichts kopiert |
//! | Datei | [`bruecke`] | [`linux`] | [`vaapi`] |
//!
//! **Die Unterschiede sind erzwungen, nicht gewaehlt**, und die Richtung ist
//! bei den ersten beiden sogar vertauscht: unter Windows gehoert die Quelle uns
//! und wird geteilt, auf dem CUDA-Weg gehoert das ZIEL uns und wird eingehaengt
//! — weil FFmpegs CUDA-Speicher nicht exportierbar ist. Der VAAPI-Weg faellt
//! aus beiden heraus: dort wird ueberhaupt nicht kopiert, die Textur zeigt auf
//! die Decoder-Surface selbst. Was das nach sich zieht (Lebensanker und
//! Deckel), steht im Kopf von [`vaapi`]; die Einzelheiten des CUDA-Weges im
//! Kopf von [`linux`]. Hier steht nur, was fuer alle gilt. Alles darunter
//! ([`angefordert`], [`abschalten`], [`bild_ohne_umweg`], der GPU-Abdruck des
//! Einfrier-Waechters, die Latenz-Sonde) ist plattformfrei und gilt fuer alle
//! drei Wege.
//!
//! **Hier stand bis zum 2026-08-10 „Was auf Linux WEITERHIN ohne Bruecke
//! laeuft: der VAAPI-Weg".** Er laeuft seither ueber [`vaapi`]; welche der
//! beiden Linux-Bruecken greift, entscheidet [`linuxweg`] am Pixelformat.
//!
//! ## Warum das unter Windows eine Bruecke ist und kein reines Durchreichen
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
//! (`ID3D12Fence::Wait`) gebaut werden, ist das der Zeitpunkt, eine gemeinsame
//! Crate anzulegen** — jene Aenderung muss ohnehin in beide Dateien.
//!
//! **Hier stand bis zum 2026-08-08 „auf wgpu 29 nicht erreichbar". Der Satz
//! war richtig und ist es seit dem Sprung auf wgpu 30 nicht mehr:**
//! `wgpu-hal-30.0.0/src/dx12/mod.rs:824` bietet `Queue::add_wait_fence` und
//! `:851` `Queue::add_signal_fence` an, die den Zaun in die naechste Abgabe
//! einreihen; wgpu 29 hatte an derselben Stelle nur `as_raw` (`:793`). Auf dem
//! Vulkan-Weg gilt dasselbe fuer `Queue::add_wait_semaphore`
//! (`vulkan/mod.rs:1552`, in wgpu 29 gab es nur `add_signal_semaphore`).
//! **Damit ist der Weg offen, nicht gebaut** — dass er sich lohnt, ist
//! weiterhin unbelegt (s. `zerocopy::linux`), und diese Migration hat ihn
//! ausdruecklich nicht angefasst.
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

/// Der Ringplatz-Stapel — von BEIDEN Bruecken benutzt, deshalb ausserhalb der
/// Plattform-Zweige.
#[cfg(any(windows, target_os = "linux"))]
mod freigabe;

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

/// Der eine Linux-Weg: CUDA schreibt in ein von Vulkan angelegtes Bild.
///
/// **Nicht `unix`, sondern `linux`.** macOS ist ebenfalls `unix`, hat aber
/// weder CUDA noch `VK_KHR_external_memory_fd`; dort gilt weiterhin der
/// Platzhalter.
#[cfg(target_os = "linux")]
mod linux;
/// Der andere: die VAAPI-Surface wird als DMA-BUF eingehaengt.
#[cfg(target_os = "linux")]
mod vaapi;
/// Die Weiche dazwischen — sie traegt die Typen, die alle anderen sehen.
#[cfg(target_os = "linux")]
mod linuxweg;
#[cfg(target_os = "linux")]
pub use linux::{kontext_bereitstellen, Ringplatz};
#[cfg(target_os = "linux")]
pub use linuxweg::{Bruecke, Einhaengung, GpuBild};
#[cfg(target_os = "linux")]
pub use vaapi::Dmabufebene;

/// Wie viele Surfaces der VAAPI-Decoder ueber seinen Bedarf hinaus anlegen
/// soll, damit ihn der Renderer nicht aushungert (`extra_hw_frames`, s.
/// [`vaapi::zusatzbilder`]).
///
/// **Plattformfrei erreichbar und ausserhalb von Linux null**, damit
/// `decode.rs` dafuer keinen `#[cfg]`-Zweig braucht. Null heisst dort schlicht
/// „FFmpegs Vorgabe", also unveraendertes Verhalten.
///
/// **Die beiden Schalter werden HIER geprueft und nur hier** — der Aufrufer ist
/// die eine Stelle, an der die Frage gestellt wird, und eine zweite Abfrage in
/// `vaapi::zusatzbilder` waere dieselbe Bedingung an zwei Orten.
pub fn zusatzbilder_vaapi() -> i32 {
    #[cfg(target_os = "linux")]
    {
        if angefordert() && vaapi::erlaubt() {
            return vaapi::zusatzbilder();
        }
        0
    }
    #[cfg(not(target_os = "linux"))]
    {
        0
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod leer;
#[cfg(not(any(windows, target_os = "linux")))]
pub use leer::{Bruecke, GpuBild};

/// Ausserhalb von Linux gibt es keinen geteilten CUDA-Kontext, den der Decoder
/// uebernehmen koennte.
#[cfg(not(target_os = "linux"))]
pub fn kontext_bereitstellen(_geraet: &Option<wgpu::Device>) -> bool {
    false
}

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
    #[cfg(target_os = "linux")]
    {
        match format {
            ffmpeg_next::format::Pixel::CUDA => true,
            // Der VAAPI-Weg hat einen eigenen Schalter (Begruendung im Kopf von
            // [`vaapi`]). Er steht hier und nicht in `vaapi::Bruecke::neu`,
            // damit ein abgeschalteter Weg gar nicht erst als Fehlschlag
            // gemeldet wird — das saehe im Log aus wie ein Defekt.
            ffmpeg_next::format::Pixel::VAAPI => vaapi::erlaubt(),
            _ => false,
        }
    }
    #[cfg(not(any(windows, target_os = "linux")))]
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
