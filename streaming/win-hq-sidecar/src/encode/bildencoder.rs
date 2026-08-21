//! Der Encoder als austauschbares Stück — damit ein anderer Encode-Weg die
//! Pipeline mitbenutzen kann, statt sie zu kopieren.
//!
//! **Warum.** `pipeline_hw` trägt den ganzen Ablauf: Aufnahme, Skalierung,
//! Taktung mit Bild-Duplizierung, A/V-Verankerung über QPC, Tick-Diagnose,
//! die Teardown-Vorkehrungen gegen den Treiber-Absturz. Das ist der Teil, der
//! schwer zu bauen war und der nirgends ein zweites Mal stehen soll.
//!
//! Gebraucht wird die Austauschbarkeit für einen **Vergleichsarm**: das Labor
//! fährt denselben Ablauf wahlweise über einen Vulkan-Encoder, um die
//! ausgelieferte Wahl gegen eine Alternative halten zu können. Der braucht
//! dieselbe Aufnahme und dieselbe Taktung — nur das letzte Stück ist ein
//! anderes. Genau dieselbe Überlegung wie bei [`super::senke`], eine Ebene
//! höher.
//!
//! **Der Vulkan-Weg ist gemessen unterlegen und deshalb nicht der
//! ausgelieferte**, damit ihn niemand erneut vorschlägt: AMF ist ihm an jedem
//! gemessenen Punkt voraus — rund 43 Prozent weniger Bits bei gleicher
//! Qualität, brauchbare Ratensteuerung, 10 Bit farblich in Ordnung.
//!
//! **Ohne Anmeldung ändert sich nichts.** Der ausgelieferte Sidecar meldet
//! nichts an; dann baut `pipeline_hw` seinen `FfmpegHwEncoder` wie immer.

use anyhow::Result;
use ffmpeg_next::ffi::{AVBufferRef, AVPixelFormat};
use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11DeviceContext};
use windows::Win32::System::Threading::CRITICAL_SECTION;

use super::encoder::AudioStreamConfig;
use super::encoder_hw::HwEncoderConfig;
use super::hwctx::OwnedHwFrame;
use crate::audio::CapturedAudio;

/// Was `pipeline_hw` von einem Encoder braucht — nicht mehr.
///
/// Die Aufteilung ist gewachsen, nicht entworfen: es ist genau die Fläche, die
/// die Pipeline heute anfasst. Wer sie erweitert, erweitert damit auch, was
/// jeder Encode-Weg leisten muss.
///
/// **Kein `Send`**, und das ist Absicht: der Encoder entsteht auf dem
/// Taktfaden und bleibt dort. Die Schranke zu fordern hieße, jedem Encode-Weg
/// etwas abzuverlangen, das niemand braucht — und der Vulkan-Weg hält rohe
/// Zeiger auf Gerät und Handles, die genau deshalb nicht `Send` sind. Wer
/// nebenläufig arbeiten will, tut das hinter seiner eigenen Naht (so wie der
/// Sendeweg über [`super::senke_writer`]).
pub trait BildEncoder {
    /// Ein Pool-Bild einschieben. `pts` ist die aus der Wanduhr abgeleitete
    /// Präsentationszeit in Encoder-Zeitbasis (1/90000, s. `crate::zeitbasis`),
    /// streng monoton.
    fn send_hw(&mut self, frame: &mut OwnedHwFrame, pts: i64) -> Result<()>;

    /// Wird gerufen, **bevor** in dieses Pool-Bild geschrieben wird.
    ///
    /// Der Regelweg braucht das nicht: FFmpeg hält die Referenz auf den Frame
    /// selbst, solange es ihn liest. Ein Encode-Weg, der die Textur in eine
    /// andere Grafik-API **importiert**, hält sie dort aber ausserhalb dieser
    /// Buchführung — er muss hier warten, bis er mit ihr fertig ist. Sonst
    /// überschreibt der Video-Prozessor ein Bild, das gerade noch kodiert
    /// wird; der Fehler zeigt sich später als zerrissenes Bild oder
    /// Geräteverlust, und nur manchmal.
    fn vor_dem_schreiben(&mut self, _ziel: &OwnedHwFrame) -> Result<()> {
        Ok(())
    }

    /// Ein Ton-Stück. Ohne Tonspur folgenlos.
    fn send_audio(&mut self, captured: &CapturedAudio) -> Result<()>;

    /// Ton-Zeitleiste am Video-Ursprung verankern. Vor dem ersten
    /// [`send_audio`](Self::send_audio) — sonst driften die Spuren.
    fn set_audio_origin(&mut self, origin: std::time::Instant, origin_qpc: Option<i64>);

    /// Dauer des letzten Einschiebens in µs (Diagnose, `tick_monitor`).
    fn last_send_us(&self) -> u64;

    /// Dauer des letzten Einreihens in µs (Diagnose).
    fn last_mux_us(&self) -> u64;

    /// (Summe, Maximum, Anzahl) der Encode-Latenz seit dem letzten Aufruf,
    /// in µs. Holt UND leert.
    fn take_encode_latency(&mut self) -> (u64, u64, u64);

    /// Strom sauber beenden.
    fn finish(&mut self) -> Result<()>;
}

/// Alles, was ein Encoder zum Aufbau braucht.
///
/// # Safety
///
/// Der Auftrag trägt zwei Zusicherungen, die der Empfänger nicht prüfen kann
/// und die deshalb hier stehen müssen:
///
/// * **`hw_frames_ref`** ist eine gültige, noch lebende `AVBufferRef` auf einen
///   `AVHWFramesContext`, dessen Format zu den Bildern passt, die später über
///   [`BildEncoder::send_hw`] kommen. Sie lebt länger als der Encoder. Wer eine
///   eigene Referenz behalten will, nimmt `av_buffer_ref`.
/// * **`lock_ptr`** zeigt auf die `CRITICAL_SECTION` des Aufnahme-Pools und
///   lebt ebenso lange. Sie ist nicht Zierrat: der immediate
///   `ID3D11DeviceContext` ist **nicht thread-sicher**, und auf ihm laufen
///   bereits die Aufnahme-Kopie (auf dem WGC-Faden) und der Blt. Wer von hier
///   aus GPU-Befehle darauf gibt, muss sie zwischen `EnterCriticalSection` und
///   `LeaveCriticalSection` setzen — sonst ist es ein Datenrennen, und das
///   zeigt sich als sporadisch zerrissenes Bild, nicht als Absturz.
pub struct EncoderAuftrag<'a> {
    pub cfg: &'a HwEncoderConfig,
    /// Der D3D11VA-Frames-Kontext, aus dem die Bilder stammen. Vertrag oben.
    pub hw_frames_ref: *mut AVBufferRef,
    /// Für Encode-Wege, die selbst auf D3D11 zugreifen müssen — der
    /// Vulkan-Weg importiert die Texturen über ein geteiltes NT-Handle und
    /// braucht dafür Gerät und Kontext.
    pub d3d_device: &'a ID3D11Device,
    pub d3d_context: &'a ID3D11DeviceContext,
    /// Der Lock, unter dem Befehle auf `d3d_context` stehen müssen. Vertrag oben.
    pub lock_ptr: *mut CRITICAL_SECTION,
    pub audio: Option<AudioStreamConfig>,
    pub url: &'a str,
}

/// Der angemeldete Encode-Weg samt seiner Anforderungen an den Bild-Pool.
///
/// **Die Pool-Anforderungen gehören hierher und nicht in den Bauer**, weil sie
/// gebraucht werden, *bevor* der Encoder existiert: der Pool entsteht beim
/// ersten aufgenommenen Bild, der Encoder erst danach. Ein Encoder, der
/// geteilte Texturen braucht, sie aber erst beim Bauen verlangt, käme zu spät —
/// der Pool stünde dann schon falsch.
pub struct EncoderBauer {
    /// Pool-Texturen als NT-Handle teilbar anlegen. Der Vulkan-Weg braucht das,
    /// weil er sie importiert (s. `HwPoolConfig::shared`).
    pub geteilte_texturen: bool,
    /// Format, das der Pool führen muss — **abhängig von der Bittiefe**.
    ///
    /// Eine Funktion und kein fester Wert, weil 8 und 10 bit verschiedene
    /// Pool-Formate brauchen (NV12 bzw. P010) und die Entscheidung damit vom
    /// Wunsch des Nutzers abhängt. Ein fester Wert hatte die Folge, dass der
    /// Wunsch „10 bit" wortlos überstimmt wurde, während er unverändert in die
    /// Encoder-Konfiguration weiterlief — ein Auftrag, der sich selbst
    /// widerspricht, ohne dass irgendwo etwas auffiele.
    ///
    /// Der Weg antwortet mit dem Format, das er **wirklich** nimmt. Die
    /// Pipeline liest die tatsächliche Bittiefe daraus zurück, statt sie
    /// getrennt mitzuführen.
    pub pool_format: fn(ten_bit: bool) -> AVPixelFormat,
    pub baue: fn(&EncoderAuftrag) -> Result<Box<dyn BildEncoder>>,
}

/// Wie der Ziel-Pool aussehen muss — die eine Stelle, an der das entschieden
/// wird.
pub(crate) struct PoolWahl {
    pub format: AVPixelFormat,
    /// Texturen als NT-Handle teilbar anlegen.
    pub geteilt: bool,
    /// **Was aus dem Pool folgt, nicht was gewünscht war.** Der Pool ist die
    /// Wahrheit über die Bittiefe; alles andere führte zu zwei Aussagen, die
    /// niemand abgleicht.
    pub ten_bit: bool,
}

/// Den Ziel-Pool bestimmen. `wunsch_ten_bit` ist bereits am Codec geprüft.
///
/// Steht hier und nicht in `pipeline_hw`, weil die Antwort vom angemeldeten
/// Weg abhängt und die Anmeldung hier wohnt — und weil die Pipeline sonst über
/// die harte Größen-Grenze wächst.
pub(crate) fn pool_wahl(wunsch_ten_bit: bool) -> PoolWahl {
    let Some(b) = BAUER.get() else {
        // Regelweg: der Encoder wandelt BGRA selbst; nur für 10 bit muss der
        // Video-Prozessor vorher nach P010 (`av1_amf` nimmt für 10 bit keinen
        // BGRA-Eingang, gemessen 2026-08-01).
        return PoolWahl {
            format: if wunsch_ten_bit {
                AVPixelFormat::AV_PIX_FMT_P010LE
            } else {
                AVPixelFormat::AV_PIX_FMT_BGRA
            },
            geteilt: false,
            ten_bit: wunsch_ten_bit,
        };
    };
    let format = (b.pool_format)(wunsch_ten_bit);
    PoolWahl {
        format,
        geteilt: b.geteilte_texturen,
        ten_bit: format == AVPixelFormat::AV_PIX_FMT_P010LE,
    }
}

static BAUER: super::einmal::EinmalBauer<EncoderBauer> = super::einmal::EinmalBauer::new();

/// Einmal beim Programmstart, vor dem ersten `start`.
pub fn registriere_encoder_bauer(bauer: EncoderBauer) {
    BAUER.registriere(
        bauer,
        "[bildencoder] WARNUNG: zweiter Encoder-Bauer ignoriert — der erste bleibt",
    );
}

/// Der angemeldete Bauer, falls es einen gibt.
pub(crate) fn angemeldet() -> Option<&'static EncoderBauer> {
    BAUER.get()
}

/// Den Encoder bauen: den angemeldeten, sonst den Regelweg.
///
/// **Steht hier und nicht in `pipeline_hw`**, damit die Entscheidung „fremder
/// Weg oder Regelweg" neben der Anmeldung liegt statt mitten im Ablauf — und
/// weil die Pipeline sonst über die harte Größen-Grenze wächst.
///
/// # Safety
///
/// Der Aufrufer erfüllt den Vertrag von [`EncoderAuftrag`] für
/// `hw_frames_ref` und `lock_ptr`.
#[allow(clippy::too_many_arguments)]
pub(crate) unsafe fn baue(
    cfg: &HwEncoderConfig,
    hw_frames_ref: *mut AVBufferRef,
    d3d_device: &ID3D11Device,
    d3d_context: &ID3D11DeviceContext,
    lock_ptr: *mut CRITICAL_SECTION,
    audio: Option<AudioStreamConfig>,
    url: &str,
) -> Result<Box<dyn BildEncoder>> {
    if let Some(b) = BAUER.get() {
        let auftrag = EncoderAuftrag {
            cfg,
            hw_frames_ref,
            d3d_device,
            d3d_context,
            lock_ptr,
            audio,
            url,
        };
        return (b.baue)(&auftrag);
    }
    // SAFETY: derselbe Vertrag, den diese Funktion vom Aufrufer verlangt.
    let enc = unsafe {
        super::encoder_hw::FfmpegHwEncoder::create(cfg, hw_frames_ref, audio, url)?
    };
    Ok(Box::new(enc))
}

/// Was beim Bauen herauskam.
pub(crate) enum Gebaut {
    Encoder(Box<dyn BildEncoder>),
    /// Kein Encoder — die Pipeline soll an `pipeline_d3d12` abgeben. Das
    /// Aufräumen bleibt beim Aufrufer: nur dort ist bekannt, was alles hängt
    /// (Aufnahme, Skalierer, Ton), und die Reihenfolge ist heikel.
    AnD3d12,
}

/// Hängt an diesem Auftrag eine Betriebsart, die KEINEN Rückfall überlebt?
/// Liefert dann ihren Namen für die Meldung, sonst `None`.
///
/// Getrennte Funktion und nicht zwei `&&` im Match-Arm, weil sie damit prüfbar
/// ist: `baue_mit_rueckfall` selbst braucht ein D3D11-Gerät und läuft in
/// keinem Test.
///
/// **HDR steht in `schirm`, nicht in einem eigenen `hdr`-Feld** — die beiden
/// sind dasselbe (Begründung an `HwEncoderConfig::schirm`). HDR zieht 10 bit
/// ohnehin nach sich (`stream_controller::run_pipeline` setzt `ten_bit`), es
/// wird trotzdem zuerst gefragt: die genauere Meldung gewinnt.
fn betriebsart_ohne_rueckfall(cfg: &HwEncoderConfig) -> Option<&'static str> {
    if cfg.schirm.is_some() {
        return Some("HDR");
    }
    cfg.ten_bit.then_some("10 bit")
}

/// Den Encoder bauen und die Rückfälle anwenden.
///
/// **Steht hier und nicht in `pipeline_hw`**, weil es Regeln über Encoder sind
/// und nicht über den Ablauf — und weil dieselbe Datei die Anmeldung führt, auf
/// die sich die wichtigste dieser Regeln bezieht.
///
/// # Safety
///
/// Wie [`baue`].
#[allow(clippy::too_many_arguments)]
pub(crate) unsafe fn baue_mit_rueckfall(
    cfg: &HwEncoderConfig,
    hw_frames_ref: *mut AVBufferRef,
    d3d_device: &ID3D11Device,
    d3d_context: &ID3D11DeviceContext,
    lock_ptr: *mut CRITICAL_SECTION,
    audio: Option<AudioStreamConfig>,
    url: &str,
    vendor: &str,
) -> Result<Gebaut> {
    let einmal = |c: super::VideoCodec, audio: Option<AudioStreamConfig>| {
        let mut cfg = cfg.clone();
        cfg.codec = c;
        // SAFETY: derselbe Vertrag, den diese Funktion vom Aufrufer verlangt.
        unsafe { baue(&cfg, hw_frames_ref, d3d_device, d3d_context, lock_ptr, audio, url) }
    };
    match einmal(cfg.codec, audio.clone()) {
        Ok(enc) => Ok(Gebaut::Encoder(enc)),
        // **Kein Rückfall, wenn sich ein Encode-Weg angemeldet hat.** Dann wäre
        // er keine Rettung, sondern eine Verfälschung: der Strom liefe über das
        // ALTE Verfahren weiter, während oben „angemeldet" im Log steht. Von
        // aussen sähe er gesund aus und beantwortete eine andere Frage als die
        // gestellte. Am 2026-08-02 genau so beobachtet, als `h264_vulkan` mit
        // Ziel-Bitrate am AMD-Treiber scheiterte und der Lauf wortlos auf
        // `h264_d3d12va` wechselte.
        Err(e) if angemeldet().is_some() => Err(e.context(
            "angemeldeter Encode-Weg liess sich nicht oeffnen — KEIN Rueckfall auf den \
             Regelweg, das waere eine Messung unter falschem Etikett",
        )),
        // **Ein abgewiesener Sendeweg ist KEIN Encoder-Problem.** Muss vor
        // BEIDEN Rückfällen darunter stehen — dem AMD-Zweig und dem AV1-Zweig.
        //
        // Beim ersten Anlauf am 2026-08-05 stand dieser Arm nur vor dem
        // AV1-Zweig. Auf einer AMD-Karte fing der Arm darunter ein HTTP 401
        // zuerst ab und meldete „nicht über D3D11 öffenbar → Delegation an
        // pipeline_d3d12" — also genau die Fehlklasse, die hier behoben werden
        // sollte, eine Ebene höher. Auf der NVIDIA-Prüfmaschine war das nicht
        // zu sehen, weil der AMD-Arm dort nie greift. Gefunden beim
        // Vereinfachungs-Durchlauf, nicht beim Messen.
        //
        // Dieselbe Regel wie beim angemeldeten Encode-Weg oben und in
        // `auffrischung.rs`: lieber ehrlich abbrechen als unter falschem
        // Etikett weiterlaufen. Ein anderer Encode-Weg hätte ohnehin nicht
        // geholfen — der Server weist den Sendeweg unabhängig davon ab.
        Err(e)
            if e.chain()
                .any(|u| u.downcast_ref::<crate::whip::SendewegAbgewiesen>().is_some()) =>
        {
            Err(e)
        }
        // **Keine Rückfälle, wenn eine Betriebsart daran hängt.** HDR und
        // 10 bit überleben KEINEN der beiden Rückfälle darunter: der
        // D3D12-Weg hat nur NV12 und keinen Farbwandler, und der AV1→H.264-
        // Griff nimmt HDR schon deshalb mit, weil `supports_ten_bit` nur AV1
        // durchlässt. Dieselbe Linie wie bei `auffrischung` und `hdr::pruefen`
        // — unerfüllbar heisst Startverweigerung, nicht still etwas anderes
        // fahren. Muss VOR beiden Rückfällen stehen.
        Err(e) if betriebsart_ohne_rueckfall(cfg).is_some() => {
            let art = betriebsart_ohne_rueckfall(cfg).unwrap_or("diese Betriebsart");
            Err(e.context(format!(
                "{art} verlangt, aber der Encoder liess sich auf dem D3D11-Weg nicht oeffnen —                  KEIN Rueckfall (D3D12 liegt fest auf NV12 und hat keinen Farbwandler, der                  AV1-Rueckfall auf H.264 traegt weder 10 bit noch HDR). Ein Rueckfall waere                  ein SDR-8-bit-Strom unter dem bestellten Etikett."
            )))
        }
        // **Das Auffangnetz für AMF-Issue #455.** Seit dem 2026-08-04 geht AMD
        // mit beiden Codecs über AMF (s. `encode_path`), und `h264_amf` auf
        // D3D11-Eingang ist genau die Konstellation, für die es das Issue gibt
        // (`SubmitInput`-Integer-Divide-by-Zero). Auf der Prüfmaschine ist der
        // Absturz nicht reproduzierbar — das ist eine Maschine, kein Beleg.
        //
        // Scheitert der Open, gibt dieser Weg deshalb an den erprobten
        // D3D12-Zweig ab, statt den Stream fallen zu lassen. Der trägt kein
        // AV1 (keine brauchbare extradata).
        //
        // **Was er ebenfalls nicht trägt, und was hier bis zum 2026-08-19
        // fehlte: HDR und 10 bit.** Der Satz an dieser Stelle lautete „ein
        // Rückfall, der die Betriebsart verschluckt, gibt es also nicht" und
        // zählte nur einen Teil der Betriebsarten auf — geprüft wurde gar
        // nichts.
        // Der D3D12-Weg legt seinen Bildpuffer fest auf NV12
        // (`encoder_d3d12.rs`), und für AV1 reicht `pipeline_d3d12` an
        // `run_cpu_pipeline` weiter, die weder ein `ten_bit`-Feld noch
        // `hdr::signalisieren` kennt. Ein HDR-Stream wäre nach diesem Rückfall
        // still 8-bit-SDR ohne PQ/BT.2020 gelaufen — ohne eine Zeile im Log.
        // Deshalb steht der Arm darunter davor; die Prüfung selbst hängt an
        // [`betriebsart_ohne_rueckfall`], damit sie nicht als Wortlaut in
        // einem Kommentar wohnt.
        Err(e) if vendor == "amd" => {
            eprintln!(
                "[pipeline-hw] {:?} nicht über D3D11 öffenbar ({e:#}) — \
                 Delegation an pipeline_d3d12",
                cfg.codec
            );
            Ok(Gebaut::AnD3d12)
        }
        // AV1-NVENC gibt es erst ab Ada (RTX 40); ältere NVIDIA/Treiber liefern
        // beim Öffnen "function not implemented" → H.264 statt Abbruch.
        Err(e) if matches!(cfg.codec, super::VideoCodec::Av1) => {
            eprintln!("[pipeline-hw] av1 HW encoder nicht verfügbar ({e:#}) → Fallback H.264");
            Ok(Gebaut::Encoder(einmal(super::VideoCodec::H264, audio)?))
        }
        Err(e) => Err(e),
    }
}

/// Der Regelweg als [`BildEncoder`].
///
/// Reine Weiterleitung; die Begründungen stehen an den Methoden selbst. Steht
/// **hier** und nicht bei `FfmpegHwEncoder`, weil der Block zu dieser
/// Abstraktion gehört — und weil `encoder_hw.rs` die Datei ist, die am
/// schwersten unter der Größen-Grenze zu halten ist.
impl BildEncoder for super::encoder_hw::FfmpegHwEncoder {
    fn send_hw(&mut self, frame: &mut OwnedHwFrame, pts: i64) -> Result<()> {
        Self::send_hw(self, frame, pts)
    }
    fn send_audio(&mut self, captured: &CapturedAudio) -> Result<()> {
        Self::send_audio(self, captured)
    }
    fn set_audio_origin(&mut self, origin: std::time::Instant, origin_qpc: Option<i64>) {
        Self::set_audio_origin(self, origin, origin_qpc)
    }
    fn last_send_us(&self) -> u64 {
        Self::last_send_us(self)
    }
    fn last_mux_us(&self) -> u64 {
        Self::last_mux_us(self)
    }
    fn take_encode_latency(&mut self) -> (u64, u64, u64) {
        Self::take_encode_latency(self)
    }
    fn finish(&mut self) -> Result<()> {
        Self::finish(self)
    }
}

#[cfg(test)]
mod tests {
    use super::betriebsart_ohne_rueckfall;
    use crate::encode::VideoCodec;
    use crate::encode::encoder_hw::HwEncoderConfig;

    fn cfg() -> HwEncoderConfig {
        HwEncoderConfig {
            codec: VideoCodec::Av1,
            vendor: "amd".to_string(),
            fps: 60,
            bitrate_kbps: 4000,
            dst_w: 1920,
            dst_h: 1080,
            ten_bit: false,
            schirm: None,
        }
    }

    /// Der Regelfall bleibt der Regelfall: ohne HDR und ohne 10 bit greifen
    /// die Rückfälle wie bisher (AMD → D3D12, AV1 → H.264).
    #[test]
    fn ohne_betriebsart_kein_riegel() {
        assert!(betriebsart_ohne_rueckfall(&cfg()).is_none());
    }

    /// Der nachgetragene Fehler: ein HDR-Auftrag darf nicht still an den
    /// D3D12-Weg abgegeben werden — der liefert 8-bit-SDR unter dem
    /// HDR-Etikett.
    #[test]
    fn hdr_verbietet_den_rueckfall() {
        let mut c = cfg();
        c.ten_bit = true;
        c.schirm = Some(crate::system::hdr::SchirmFarbe {
            hdr_aktiv: true,
            bits_je_kanal: 10,
            max_nits: 530.0,
            max_vollbild_nits: 400.0,
            min_nits: 0.0001,
            primaervalenzen: [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]],
            weisspunkt: [0.3127, 0.329],
        });
        assert_eq!(betriebsart_ohne_rueckfall(&c), Some("HDR"));
    }

    /// 10 bit ohne HDR ebenso — beide Rückfälle liegen fest auf 8 bit.
    #[test]
    fn zehn_bit_verbietet_den_rueckfall() {
        let mut c = cfg();
        c.ten_bit = true;
        assert_eq!(betriebsart_ohne_rueckfall(&c), Some("10 bit"));
    }

    /// Ohne Anmeldung baut die Pipeline ihren eigenen Encoder — der
    /// ausgelieferte Sidecar verhält sich also unverändert. Gleiche Absicherung
    /// wie bei `senke`, gleiche Fehlerart: ein Vorgabe-Bauer hier würde
    /// unbemerkt einen anderen Encode-Weg wählen, und das sähe man nur an
    /// Zahlen, die niemand mehr erklären kann.
    #[test]
    fn ohne_anmeldung_kein_bauer() {
        assert!(super::angemeldet().is_none());
    }
}
