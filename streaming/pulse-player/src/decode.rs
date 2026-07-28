//! Video-Decode ueber FFmpeg, Hardware zuerst.
//!
//! Hintergrund (gemessen 2026-07-26 auf der Dev-Maschine): Chromium nutzt auf
//! Linux/NVIDIA **kein** NVDEC — weder fuer H.264 noch fuer AV1, auch nicht mit
//! den ueblichen VA-API-Flags. `nvidia-smi dmon` zeigte durchgehend 0 % im
//! `dec`-Zaehler bei ~46 % CPU-Last eines Kerns. Dieser Player waehlt den
//! Decoder deshalb **explizit** statt zu hoffen.
//!
//! Vorgehen: erst einen hardwaregestuetzten Decoder ueber seinen Namen suchen
//! (`av1_cuvid`, `h264_cuvid`, `*_qsv`, `*_vaapi`), sonst Software. Die
//! cuvid-Decoder liefern ihre Frames in den Hauptspeicher; der Decode selbst
//! laeuft auf der GPU. Das ist noch nicht zero-copy — ein direkter Weg von
//! NVDEC in eine Vulkan-Textur waere die naechste Ausbaustufe, verlangt aber
//! `hw_frames_ctx` samt Interop und ist bewusst nicht Teil des ersten Wurfs.
//!
//! LIZENZ: FFmpeg muss in ausgelieferten Builds LGPL-konfiguriert und dynamisch
//! gelinkt sein — siehe Cargo.toml und THIRD-PARTY-NOTICES.md.

use anyhow::{anyhow, bail, Context, Result};
use ffmpeg_next as ffmpeg;

use crate::whep::Codec;

/// Erkennt am Decoder-Namen, ob er auf der GPU laeuft.
fn is_hardware(name: &str) -> bool {
    ["cuvid", "qsv", "vaapi"].iter().any(|tag| name.contains(tag))
}

/// Aufeinanderfolgende abgelehnte Einheiten, ab denen der Decoder als defekt
/// gilt. Bei 60 fps ist das eine halbe Sekunde.
const ERROR_LIMIT: u32 = 30;

/// Wie viele Einheiten auf einen Einstiegspunkt gewartet wird, bevor die
/// Sitzung aufgibt. Bei 60 fps sind das zehn Sekunden.
///
/// Es MUSS eine Grenze geben: kommt nie ein Keyframe, waere stilles Warten
/// wieder genau das Verhalten, das eine Kachel dauerhaft in "verbinde"
/// stehen laesst — nur mit einer anderen Ursache.
const MAX_UNITS_WITHOUT_KEYFRAME: u64 = 600;

/// Wie oft neu aufgebaut wird, bevor die Sitzung als gescheitert gilt.
const MAX_REBUILDS: u32 = 2;

/// Was nach einer abgelehnten Einheit zu tun ist.
///
/// Der Unterschied ist der Kern der Sache: **einzelne** Ablehnungen sind
/// normal — nach einer Paketluecke ist die naechste Einheit unvollstaendig,
/// bis ein Keyframe kommt, und die darf die Wiedergabe nicht beenden. Ein
/// **dauerhaft toter** Decoder sieht an der Stelle aber genau gleich aus.
/// Beobachtet am 2026-07-26: beim zweiten Oeffnen einer Sitzung meldete
/// `av1_cuvid` fuer jedes Paket `CUDA_ERROR_UNKNOWN`. Weil jeder Fehler
/// einzeln als "kaputter Frame" durchging, blieb das Bild schwarz, ohne dass
/// irgendwo ein Fehler ankam. Erst die Unterscheidung nach Haeufigkeit macht
/// den Unterschied sichtbar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ErrorAction {
    /// Vereinzelt — weitermachen.
    Ignore,
    /// Anhaltend — Decoder neu aufbauen.
    Rebuild,
    /// Auch nach Neuaufbau kaputt — Sitzung beenden.
    GiveUp,
}

fn classify(consecutive_errors: u32, rebuilds: u32) -> ErrorAction {
    if consecutive_errors < ERROR_LIMIT {
        ErrorAction::Ignore
    } else if rebuilds < MAX_REBUILDS {
        ErrorAction::Rebuild
    } else {
        ErrorAction::GiveUp
    }
}

/// Kandidaten in Reihenfolge der Bevorzugung. Am Ende stehen immer die
/// Software-Decoder; der jeweils letzte ist der generische Name, weil die
/// bevorzugte Bibliothek (z. B. `libdav1d`) nicht in jedem Build steckt.
fn candidates(codec: Codec, allow_hw: bool) -> Vec<&'static str> {
    let (hw, sw): (&[&str], &[&str]) = match codec {
        Codec::Av1 => (&["av1_cuvid", "av1_qsv", "av1_vaapi"], &["libdav1d", "av1"]),
        Codec::H264 => (&["h264_cuvid", "h264_qsv", "h264_vaapi"], &["h264"]),
        Codec::Opus => (&[], &["libopus", "opus"]),
    };
    let mut out = Vec::new();
    if allow_hw {
        out.extend_from_slice(hw);
    }
    out.extend_from_slice(sw);
    out
}

/// Vorrat wiederverwendbarer Ebenen-Puffer.
///
/// **Warum es das gibt.** Ohne Vorrat holte jedes Bild frische Puffer in
/// Bildgroesse — 5,5 MB bei 8 bit, 11 MB bei 10 bit, also bis 660 MB/s bei
/// 60 Bildern. Teuer ist dabei nicht die Datenmenge, sondern die Anforderung
/// selbst: Bloecke dieser Groesse holt der Allokator direkt vom
/// Betriebssystem, und jede Speicherseite muss beim ersten Beruehren
/// eingerichtet werden (bei 11 MB rund 2700 Stueck pro Bild).
///
/// Die Puffer kehren im `Drop` des Bildes zurueck — also auf dem Thread, der
/// es zuletzt gehalten hat. Deshalb ein geteilter Vorrat mit Sperre und nicht
/// ein Feld im Decoder: der Rueckweg fuehrt ueber eine Thread-Grenze.
#[derive(Clone, Default)]
pub struct PlanePool(std::sync::Arc<std::sync::Mutex<Vec<Vec<u8>>>>);

/// Obergrenze des Vorrats. Mehr als ein paar Bilder koennen nie gleichzeitig
/// unterwegs sein (Kanal + gehaltenes Bild); ohne Grenze wuerde ein Stau
/// Speicher dauerhaft binden, statt ihn zurueckzugeben.
const POOL_MAX: usize = 8;

impl PlanePool {
    /// Einen Puffer mit mindestens `needed` Bytes Platz holen — leer, aber mit
    /// erhaltener Kapazitaet, wenn er aus dem Vorrat kommt.
    fn take(&self, needed: usize) -> Vec<u8> {
        let mut buf = match self.0.lock() {
            Ok(mut pool) => pool.pop().unwrap_or_default(),
            // Vergiftete Sperre (Panik in einem anderen Thread): ohne Vorrat
            // weitermachen ist besser als das Bild fallen zu lassen.
            Err(_) => Vec::new(),
        };
        buf.clear();
        buf.reserve(needed);
        buf
    }

    /// Wie viele Puffer gerade im Vorrat liegen — nur fuer die Tests, damit die
    /// Obergrenze pruefbar ist, ohne sie ueber Umwege zu erschliessen.
    #[cfg(test)]
    fn stock(&self) -> usize {
        self.0.lock().map(|p| p.len()).unwrap_or(0)
    }

    fn give_back(&self, mut buffers: Vec<Vec<u8>>) {
        let Ok(mut pool) = self.0.lock() else { return };
        for mut buf in buffers.drain(..) {
            if pool.len() >= POOL_MAX {
                return;
            }
            buf.clear();
            pool.push(buf);
        }
    }
}

/// Ein dekodiertes Bild in der Form, die der Renderer erwartet.
pub struct DecodedFrame {
    pub width: u32,
    pub height: u32,
    pub format: PixelLayout,
    /// Ebenen als eigene Puffer (Y, U, V bzw. Y, UV).
    pub planes: Vec<Vec<u8>>,
    pub strides: Vec<usize>,
    /// Zehn Bit pro Komponente statt acht.
    pub ten_bit: bool,
    /// Voller Wertebereich (`pc`) statt begrenztem (`tv`).
    pub full_range: bool,
    /// Welche YUV-Matrix der Strom verlangt.
    pub matrix: ColorMatrix,
    /// Wann das Paket eintraf, das die Zugriffseinheit dieses Bildes
    /// abschloss. Traegt die Latenzmessung bis zum gezeichneten Bild; `None`,
    /// wenn das Bild nicht aus einem Netzpaket stammt (Tests).
    pub arrived: Option<std::time::Instant>,
    /// Wohin die Ebenen-Puffer zurueckgehen (s. [`PlanePool`]).
    pool: PlanePool,
}

#[cfg(test)]
impl DecodedFrame {
    /// Bild aus fertigen Ebenen bauen — nur fuer Tests (die Latenz-Sonde muss
    /// gegen ein Bild mit bekanntem Inhalt geprueft werden koennen).
    pub fn for_test(
        width: u32,
        height: u32,
        planes: Vec<Vec<u8>>,
        strides: Vec<usize>,
        ten_bit: bool,
    ) -> Self {
        Self {
            width,
            height,
            format: PixelLayout::Planar420,
            planes,
            strides,
            ten_bit,
            full_range: false,
            matrix: ColorMatrix::Bt709,
            arrived: None,
            pool: PlanePool::default(),
        }
    }
}

impl Drop for DecodedFrame {
    fn drop(&mut self) {
        self.pool.give_back(std::mem::take(&mut self.planes));
    }
}

/// Die beiden YUV-Matrizen, die in der Praxis vorkommen.
///
/// Nicht kosmetisch: BT.601-Daten durch die BT.709-Matrix zu schicken
/// entsaettigt und verschiebt die Farben sichtbar — das Bild wirkt flau.
/// Gemessen am 2026-07-26 meldet der GSR-Stream `BT470BG`, also BT.601,
/// obwohl 1440p sonst BT.709 nahelegt. Deshalb wird die Angabe des Stroms
/// befolgt und nicht aus der Aufloesung geraten.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorMatrix {
    Bt601,
    Bt709,
}

/// Ohne Angabe gilt die uebliche Regel: SD ist BT.601, HD ist BT.709.
///
/// `PULSE_PLAYER_MATRIX=601|709` nagelt die Wahl fest — Gegenstueck zu
/// `PULSE_PLAYER_SURFACE`, damit sich Matrix und Oberflaechenformat als
/// Fehlerursache einzeln ausschliessen lassen.
fn matrix_of(space: ffmpeg::color::Space, height: u32) -> ColorMatrix {
    if let Ok(raw) = std::env::var("PULSE_PLAYER_MATRIX") {
        match raw.trim() {
            "601" => return ColorMatrix::Bt601,
            "709" => return ColorMatrix::Bt709,
            _ => {}
        }
    }
    use ffmpeg::color::Space;
    match space {
        Space::BT470BG | Space::SMPTE170M | Space::SMPTE240M => ColorMatrix::Bt601,
        Space::BT709 => ColorMatrix::Bt709,
        _ => {
            if height <= 576 {
                ColorMatrix::Bt601
            } else {
                ColorMatrix::Bt709
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PixelLayout {
    /// Drei Ebenen: Y, U, V.
    Planar420,
    /// Zwei Ebenen: Y und verschraenktes UV.
    BiPlanar420,
}

pub struct VideoDecoder {
    decoder: ffmpeg::decoder::Video,
    /// Name des tatsaechlich gewaehlten Decoders (fuer Diagnose und Statistik).
    pub name: String,
    pub hardware: bool,
    /// Fuer den Neuaufbau: welcher Codec urspruenglich verlangt war.
    codec: Codec,
    /// Abgelehnte Einheiten in Folge; jede angenommene setzt zurueck.
    consecutive_errors: u32,
    /// Bisherige Neuaufbauten (s. [`classify`]).
    rebuilds: u32,
    /// Solange gesetzt, wird jede Einheit verworfen, die kein Einstiegspunkt
    /// ist. Siehe [`VideoDecoder::decode`].
    awaiting_keyframe: bool,
    /// Wie viele Einheiten dabei bisher verworfen wurden.
    skipped_before_keyframe: u64,
    /// Vorrat fuer die Ebenen-Puffer (s. [`PlanePool`]). Ueberlebt den
    /// Neuaufbau des Decoders, weil die Puffergroessen dieselben bleiben.
    plane_pool: PlanePool,
}

impl VideoDecoder {
    /// Legt einen Decoder an. `allow_hw = None` bedeutet automatisch.
    pub fn new(codec: Codec, allow_hw: Option<bool>) -> Result<Self> {
        ffmpeg::init().context("FFmpeg-Initialisierung")?;
        if !codec.is_video() {
            bail!("{} ist kein Video-Codec", codec.as_str());
        }
        let allow = allow_hw.unwrap_or(true);

        let mut last_err = None;
        for name in candidates(codec, allow) {
            match Self::try_open(name) {
                Ok(decoder) => {
                    let hardware = is_hardware(name);
                    eprintln!(
                        "pulse-player: Decoder {name} ({})",
                        if hardware { "Hardware" } else { "Software" }
                    );
                    return Ok(Self {
                        decoder,
                        name: name.to_string(),
                        hardware,
                        codec,
                        consecutive_errors: 0,
                        rebuilds: 0,
                        awaiting_keyframe: true,
                        skipped_before_keyframe: 0,
                        plane_pool: PlanePool::default(),
                    });
                }
                Err(e) => last_err = Some(e),
            }
        }
        Err(last_err.unwrap_or_else(|| anyhow!("kein Decoder fuer {}", codec.as_str())))
    }

    fn try_open(name: &str) -> Result<ffmpeg::decoder::Video> {
        let codec = ffmpeg::decoder::find_by_name(name)
            .ok_or_else(|| anyhow!("Decoder {name} nicht vorhanden"))?;
        let mut ctx = ffmpeg::codec::context::Context::new_with_codec(codec);
        // AV_CODEC_FLAG_LOW_DELAY — fuer eine Live-Wiedergabe nicht optional.
        //
        // Ohne dieses Flag gibt FFmpeg den NVDEC-Decodern eine Anzeige-
        // verzoegerung von VIER Bildern mit (`ulMaxDisplayDelay = 4` in
        // cuvid.c, nur bei gesetztem Flag 0); Software-Decoder halten ueber
        // Frame-Threading ebenfalls Bilder zurueck. Beides ist fuer eine Datei
        // richtig und fuer einen Live-Strom falsch: es kostet bei 60 fps rund
        // 60 ms, ohne irgendetwas zu verbessern — Bildreihenfolge gibt es hier
        // nicht, der Sender schickt keine B-Bilder.
        //
        // Gefunden am 2026-07-27, weil die Kette nicht aufging: alle Posten
        // einzeln gemessen ergaben 41 ms, Ende zu Ende meldete 83. Die Luecke
        // war in der Statistik unsichtbar, weil `session.rs` jedem
        // herausfallenden Bild die Ankunftszeit der GERADE eingespeisten
        // Einheit gibt — haelt der Decoder Bilder zurueck, bekommt ein altes
        // Bild einen zu neuen Stempel und `glass` misst die eigene Wartezeit
        // nicht mit.
        ctx.set_flags(ffmpeg::codec::Flags::LOW_DELAY);
        ctx.decoder()
            .video()
            .with_context(|| format!("Decoder {name} liess sich nicht oeffnen"))
    }

    /// Schiebt eine Zugriffseinheit hinein und holt alle fertigen Bilder ab.
    ///
    /// Vor dem ersten Einstiegspunkt wird alles verworfen. Das ist keine
    /// Vorsichtsmassnahme, sondern notwendig: wer in einen laufenden Strom
    /// einsteigt, bekommt zunaechst nur Differenzbilder — bei AV1 sogar ohne
    /// den Sequence-Header, der Aufloesung und Farbtiefe ueberhaupt erst
    /// festlegt. Gemessen am 2026-07-26 an einem echten GSR-Stream: ueber 463
    /// Pakete kamen ausschliesslich `TEMPORAL_DELIMITER` und `FRAME` an, kein
    /// einziger Sequence-Header. `av1_cuvid` las daraus eine Bittiefe von 16
    /// (die es in AV1 nicht gibt) und riss den CUDA-Kontext mit; `libdav1d`
    /// meldete an denselben Daten "Error parsing OBU data". Der Browser macht
    /// an dieser Stelle dasselbe wie wir jetzt: verwerfen und warten.
    ///
    /// `Err` heisst: der Decoder ist endgueltig hin und auch ein Neuaufbau hat
    /// nicht geholfen. Der Aufrufer muss die Sitzung dann beenden — stillem
    /// Weiterlaufen entspraeche ein dauerhaft schwarzes Bild.
    pub fn decode(&mut self, data: &[u8]) -> Result<Vec<DecodedFrame>> {
        if self.awaiting_keyframe {
            if !crate::recorder::is_keyframe(self.codec, data) {
                self.skipped_before_keyframe += 1;
                if self.skipped_before_keyframe > MAX_UNITS_WITHOUT_KEYFRAME {
                    bail!(
                        "kein Einstiegspunkt nach {} Einheiten — der Sender schickt \
                         zu selten ein Vollbild",
                        self.skipped_before_keyframe
                    );
                }
                return Ok(Vec::new());
            }
            // Diese Zahl beantwortet, wie lange ein Zuschauer auf das erste
            // Bild wartet, und damit, ob das Keyframe-Intervall des Senders
            // taugt. Deshalb wird sie gemeldet, auch wenn sie 0 ist.
            eprintln!(
                "pulse-player: Einstiegspunkt gefunden, {} Einheiten davor verworfen",
                self.skipped_before_keyframe
            );
            self.awaiting_keyframe = false;
        }

        let packet = ffmpeg::codec::packet::Packet::copy(data);
        if let Err(e) = self.decoder.send_packet(&packet) {
            self.consecutive_errors += 1;
            // Nur den ersten melden: bei einem toten Decoder waeren es sonst
            // Dutzende gleicher Zeilen pro Sekunde.
            if self.consecutive_errors == 1 {
                eprintln!("pulse-player: send_packet: {e}");
            }
            // Nach einem abgelehnten Paket den Decoder leeren, bevor das
            // naechste hineingeht. Ohne das arbeitet er auf dem Zustand weiter,
            // in dem er gerade gescheitert ist — bei `cuvid` steht dahinter ein
            // CUDA-Kontext, und genau dort wurde am 2026-07-28 ein Segfault
            // beobachtet. Fehlte bisher komplett.
            self.decoder.flush();
            match classify(self.consecutive_errors, self.rebuilds) {
                ErrorAction::Ignore => {}
                ErrorAction::Rebuild => self.rebuild(&e.to_string())?,
                ErrorAction::GiveUp => bail!(
                    "Decoder {} nimmt seit {} Einheiten keine Pakete mehr an ({e})",
                    self.name,
                    self.consecutive_errors
                ),
            }
            return Ok(Vec::new());
        }
        self.consecutive_errors = 0;
        Ok(self.drain())
    }

    /// Ersetzt den Decoder durch einen frischen Software-Decoder.
    ///
    /// Bewusst **immer** Software: wenn ein Decoder anhaltend jedes Paket
    /// ablehnt, ist der Hardware-Pfad der wahrscheinlichste Schuldige (beim
    /// beobachteten Fall ein zerschossener CUDA-Kontext). Ein zweiter Anlauf
    /// auf derselben Hardware wuerde denselben Fehler wiederholen. Software
    /// kostet CPU, liefert aber ein Bild.
    ///
    /// Nach dem Tausch fehlt dem neuen Decoder der Referenzrahmen; bis zum
    /// naechsten Keyframe bleiben Einheiten unbrauchbar. Der Zaehler startet
    /// deshalb bei null, sonst gaebe genau diese Anlaufphase sofort auf.
    fn rebuild(&mut self, cause: &str) -> Result<()> {
        self.rebuilds += 1;
        eprintln!(
            "pulse-player: Decoder {} lehnt dauerhaft ab ({cause}) — \
             Neuaufbau {}/{MAX_REBUILDS} als Software",
            self.name, self.rebuilds
        );
        let fresh = Self::new(self.codec, Some(false))?;
        self.decoder = fresh.decoder;
        self.name = fresh.name;
        self.hardware = fresh.hardware;
        self.consecutive_errors = 0;
        // Ein frischer Decoder hat weder Sequence-Header noch Referenzbild —
        // er braucht denselben Einstiegspunkt wie beim Sitzungsbeginn.
        self.awaiting_keyframe = true;
        self.skipped_before_keyframe = 0;
        Ok(())
    }

    /// Nach einem Paketverlust wieder auf einen Einstiegspunkt warten.
    ///
    /// **Das ist kein Komfort, sondern ein Absturzschutz.** Der Jitter-Puffer
    /// meldet eine Luecke, der Zusammensetzer verwirft die angefangene Einheit —
    /// aber die NAECHSTE Einheit ist ein Differenzbild, dessen Referenzbild nie
    /// angekommen ist. Genau das darf ein Decoder nicht sehen.
    ///
    /// Gemessen am 2026-07-28 mit 1 % kuenstlichem Paketverlust auf dem
    /// Empfangsweg: `libnvcuvid` **stuerzt ab** (`segfault ... in
    /// libnvcuvid.so`), der ganze Player-Prozess ist weg — kein Standbild, kein
    /// Fehler, kein Log. Die Sperre gab es bereits fuer den Sitzungsbeginn und
    /// den Decoder-Neuaufbau; nur der haeufigste Fall, gewoehnlicher
    /// Paketverlust im Betrieb, war nicht abgedeckt.
    ///
    /// Der Zaehler startet bei null, damit eine Luecke kurz vor dem naechsten
    /// Keyframe nicht faelschlich als "der Sender schickt keine Vollbilder"
    /// gewertet wird.
    pub fn on_gap(&mut self) {
        // Weiterdekodieren statt warten (Versuch, hinter
        // `PULSE_PLAYER_DECODE_THROUGH=1`).
        //
        // Chromium tut genau das und liegt deshalb unter Paketverlust vorn:
        // 85 ms gleichmaessig gegen 38-369 ms unberechenbar (2026-07-28). Es
        // kann kein fehlendes Referenzbild erfinden — es behaelt das ALTE und
        // rechnet die folgenden Differenzbilder darauf. Das gibt Artefakte,
        // aber ein Bild.
        //
        // Deshalb hier ausdruecklich NICHT leeren: ein geleerter Decoder hat gar
        // keine Referenz mehr und kann dann gar nichts rechnen. Am 2026-07-28
        // gemessen — mit `flush` an dieser Stelle blieb die Bildrate bei 0,
        // obwohl kein Absturz mehr auftrat.
        if std::env::var("PULSE_PLAYER_DECODE_THROUGH").as_deref() == Ok("1") {
            return;
        }

        // Regulaerer Weg: auf einen Einstiegspunkt warten. Dann den Decoder
        // LEEREN, nicht nur aufhoeren ihn zu fuettern.
        //
        // Das fehlte bisher, und es ist der Verdacht fuer den Segfault: nach
        // einer Luecke haelt der Decoder Referenzen auf Bilder, die nie
        // ankommen. `flush` wirft den Zustand weg, sodass der naechste
        // Einstiegspunkt auf einen sauberen Decoder trifft statt auf einen halb
        // gefuellten.
        self.decoder.flush();
        if self.awaiting_keyframe {
            return; // schon scharf, Zaehler nicht zuruecksetzen
        }
        self.awaiting_keyframe = true;
        self.skipped_before_keyframe = 0;
    }

    fn drain(&mut self) -> Vec<DecodedFrame> {
        let mut out = Vec::new();
        let mut frame = ffmpeg::util::frame::video::Video::empty();
        while self.decoder.receive_frame(&mut frame).is_ok() {
            if let Some(f) = convert(&frame, &self.plane_pool) {
                out.push(f);
            }
        }
        out
    }
}

/// Uebersetzt ein FFmpeg-Bild in unsere schlanke Form. Nicht unterstuetzte
/// Pixelformate liefern `None`, statt still etwas Falsches zu zeigen.
fn convert(
    frame: &ffmpeg::util::frame::video::Video,
    pool: &PlanePool,
) -> Option<DecodedFrame> {
    use ffmpeg::format::Pixel;

    let (layout, ten_bit, planes_n) = match frame.format() {
        Pixel::YUV420P => (PixelLayout::Planar420, false, 3),
        Pixel::YUV420P10LE => (PixelLayout::Planar420, true, 3),
        Pixel::NV12 => (PixelLayout::BiPlanar420, false, 2),
        Pixel::P010LE => (PixelLayout::BiPlanar420, true, 2),
        other => {
            eprintln!("pulse-player: Pixelformat {other:?} wird nicht unterstuetzt");
            return None;
        }
    };

    // Einmalig: was der Strom ueber seine Farben SAGT. Ohne diese Zeile bleibt
    // jede Farbabweichung Ratesache — genau das ist am 2026-07-26 zweimal
    // passiert (erst zu flau, nach der Gegenmassnahme zu dunkel).
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        eprintln!(
            "pulse-player: Farbe: format={:?} range={:?} space={:?} transfer={:?} primaries={:?}, Zeilenabstand {}",
            frame.format(),
            frame.color_range(),
            frame.color_space(),
            frame.color_transfer_characteristic(),
            frame.color_primaries(),
            // Entscheidet, ob wgpu beim Hochladen den schnellen Pfad nimmt: der
            // greift nur bei einem auf 256 Byte ausgerichteten Abstand, sonst
            // wird ZEILENWEISE kopiert (bei 1080p waeren das 1620 Kleinkopien
            // je Bild). Kostet nichts, beantwortet die Frage im Log.
            frame.stride(0),
        );
    });

    let width = frame.width();
    let height = frame.height();
    let mut planes = Vec::with_capacity(planes_n);
    let mut strides = Vec::with_capacity(planes_n);
    for i in 0..planes_n {
        let stride = frame.stride(i);
        // Chroma-Ebenen sind bei 4:2:0 halb so hoch.
        let rows = if i == 0 { height } else { height.div_ceil(2) } as usize;
        let data = frame.data(i);
        let needed = stride * rows;
        if data.len() < needed {
            eprintln!("pulse-player: Ebene {i} zu kurz ({} < {needed})", data.len());
            return None;
        }
        // Aus dem Vorrat statt frisch: `clear` + `extend_from_slice` behaelt die
        // Kapazitaet, es wird also nach dem ersten Bild nichts mehr angefordert.
        let mut buf = pool.take(needed);
        buf.extend_from_slice(&data[..needed]);
        planes.push(buf);
        strides.push(stride);
    }

    Some(DecodedFrame {
        arrived: None,
        width,
        height,
        format: layout,
        planes,
        strides,
        ten_bit,
        full_range: matches!(frame.color_range(), ffmpeg::color::Range::JPEG),
        matrix: matrix_of(frame.color_space(), height),
        pool: pool.clone(),
    })
}

#[cfg(test)]
mod pool_tests {
    use super::*;

    /// Der Zweck des Vorrats: nach dem ersten Bild darf kein Speicher mehr
    /// angefordert werden. Geprueft wird genau das — der zurueckgegebene Puffer
    /// kommt mit seiner Kapazitaet wieder heraus.
    #[test]
    fn puffer_kehrt_mit_kapazitaet_zurueck() {
        let pool = PlanePool::default();
        let mut buf = pool.take(4096);
        buf.extend_from_slice(&[7u8; 4096]);
        let kapazitaet = buf.capacity();
        pool.give_back(vec![buf]);

        let wieder = pool.take(4096);
        assert!(wieder.is_empty(), "Inhalt muss geleert sein, sonst haengt Bildmuell an");
        assert!(
            wieder.capacity() >= kapazitaet,
            "Kapazitaet verloren ({} < {kapazitaet}) — dann allokiert jedes Bild neu",
            wieder.capacity()
        );
    }

    /// Ohne Obergrenze wuerde ein Stau Speicher dauerhaft binden.
    #[test]
    fn vorrat_ist_begrenzt() {
        let pool = PlanePool::default();
        pool.give_back((0..POOL_MAX + 5).map(|_| vec![0u8; 8]).collect());
        assert_eq!(pool.stock(), POOL_MAX, "Vorrat muss bei {POOL_MAX} deckeln");
    }

    #[test]
    fn take_liefert_auch_ohne_vorrat() {
        let pool = PlanePool::default();
        let buf = pool.take(1024);
        assert!(buf.capacity() >= 1024, "leerer Vorrat muss frisch anfordern");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kandidaten_enden_immer_auf_software() {
        let av1 = candidates(Codec::Av1, true);
        assert!(av1.first().unwrap().contains("cuvid"), "Hardware zuerst: {av1:?}");
        assert!(av1.contains(&"libdav1d"), "Software-Rueckfall fehlt: {av1:?}");

        let h264 = candidates(Codec::H264, true);
        assert!(h264.contains(&"h264"), "Software-Rueckfall fehlt: {h264:?}");
    }

    #[test]
    fn ohne_hardware_nur_software() {
        let list = candidates(Codec::Av1, false);
        assert!(
            !list.iter().any(|n| n.contains("cuvid") || n.contains("vaapi")),
            "Hardware darf abschaltbar sein: {list:?}"
        );
    }

    /// Vereinzelte Ablehnungen sind Normalbetrieb (unvollstaendige Einheit
    /// nach einer Paketluecke) und duerfen nichts ausloesen.
    #[test]
    fn einzelne_fehler_werden_ignoriert() {
        assert_eq!(classify(1, 0), ErrorAction::Ignore);
        assert_eq!(classify(ERROR_LIMIT - 1, 0), ErrorAction::Ignore);
    }

    /// Anhaltende Ablehnung heisst kaputter Decoder — der Neuaufbau ist der
    /// Unterschied zwischen "faengt sich" und "bleibt schwarz".
    #[test]
    fn anhaltende_fehler_loesen_neuaufbau_aus() {
        assert_eq!(classify(ERROR_LIMIT, 0), ErrorAction::Rebuild);
        assert_eq!(classify(ERROR_LIMIT * 3, MAX_REBUILDS - 1), ErrorAction::Rebuild);
    }

    /// Irgendwann muss Schluss sein: sonst baut der Player endlos neu auf und
    /// der Nutzer sieht weiter nichts, ohne je einen Fehler zu bekommen.
    #[test]
    fn nach_den_versuchen_wird_aufgegeben() {
        assert_eq!(classify(ERROR_LIMIT, MAX_REBUILDS), ErrorAction::GiveUp);
    }

    /// Die Angabe des Stroms schlaegt jede Vermutung — auch wenn sie der
    /// Aufloesung widerspricht. Genau dieser Fall trat auf: 1440p mit
    /// BT470BG-Kennung, wo man BT.709 erwarten wuerde.
    #[test]
    fn matrix_folgt_der_angabe_des_stroms() {
        use ffmpeg::color::Space;
        assert_eq!(matrix_of(Space::BT470BG, 1440), ColorMatrix::Bt601);
        assert_eq!(matrix_of(Space::SMPTE170M, 2160), ColorMatrix::Bt601);
        assert_eq!(matrix_of(Space::BT709, 240), ColorMatrix::Bt709);
    }

    /// Ohne Angabe bleibt nur die uebliche Regel nach Bildhoehe.
    #[test]
    fn ohne_angabe_entscheidet_die_bildhoehe() {
        use ffmpeg::color::Space;
        assert_eq!(matrix_of(Space::Unspecified, 480), ColorMatrix::Bt601);
        assert_eq!(matrix_of(Space::Unspecified, 576), ColorMatrix::Bt601);
        assert_eq!(matrix_of(Space::Unspecified, 720), ColorMatrix::Bt709);
        assert_eq!(matrix_of(Space::Unspecified, 1440), ColorMatrix::Bt709);
    }

    /// Der Kern des Befunds vom 2026-07-26: eine AV1-Einheit aus Temporal
    /// Delimiter und Frame — genau das, was ein Zuschauer beim Einstieg mitten
    /// im Strom bekommt — darf NICHT in den Decoder. Ohne Sequence-Header
    /// zerbricht er daran.
    #[test]
    fn einheit_ohne_sequence_header_wird_verworfen() {
        let mut d = VideoDecoder::new(Codec::Av1, Some(false)).expect("AV1-Software-Decoder");
        // OBU_FRAME (Typ 6) mit Groessenfeld, wie ihn der Depacketizer baut.
        let frame = [0x32u8, 0x03, 0xAA, 0xBB, 0xCC];
        let out = d.decode(&frame).expect("verwerfen ist kein Fehler");
        assert!(out.is_empty(), "vor dem Einstiegspunkt darf nichts herauskommen");
        assert_eq!(d.skipped_before_keyframe, 1);
        assert!(d.awaiting_keyframe, "es fehlt weiterhin ein Einstiegspunkt");
    }

    /// Sobald ein Sequence-Header dabei ist, wird eingespeist.
    #[test]
    fn sequence_header_beendet_das_warten() {
        let mut d = VideoDecoder::new(Codec::Av1, Some(false)).expect("AV1-Software-Decoder");
        // OBU_SEQUENCE_HEADER (Typ 1) mit Groessenfeld.
        let seq = [0x0Au8, 0x02, 0x00, 0x00];
        let _ = d.decode(&seq);
        assert!(!d.awaiting_keyframe, "Sequence-Header ist der Einstiegspunkt");
    }

    /// Ewiges Warten waere wieder eine haengende Kachel — nur mit anderer
    /// Ursache. Nach der Grenze muss ein Fehler kommen.
    #[test]
    fn ewiges_warten_endet_mit_fehler() {
        let mut d = VideoDecoder::new(Codec::Av1, Some(false)).expect("AV1-Software-Decoder");
        let frame = [0x32u8, 0x03, 0xAA, 0xBB, 0xCC];
        for _ in 0..MAX_UNITS_WITHOUT_KEYFRAME {
            assert!(d.decode(&frame).is_ok(), "innerhalb der Grenze wird nur verworfen");
        }
        // Kein `expect_err`: `DecodedFrame` traegt kein `Debug`, und es nur
        // fuer eine Testmeldung anzuhaengen waere der falsche Preis.
        let Err(err) = d.decode(&frame) else {
            panic!("nach der Grenze muss ein Fehler kommen");
        };
        assert!(format!("{err:#}").contains("Einstiegspunkt"), "Meldung: {err:#}");
    }

    /// Nach einem Neuaufbau fehlt dem neuen Decoder alles — er muss wieder
    /// auf einen Einstiegspunkt warten, sonst bekommt er denselben Muell wie
    /// sein Vorgaenger.
    #[test]
    fn neuaufbau_wartet_erneut_auf_einstiegspunkt() {
        let mut d = VideoDecoder::new(Codec::Av1, Some(false)).expect("AV1-Software-Decoder");
        d.awaiting_keyframe = false;
        d.skipped_before_keyframe = 7;
        d.rebuild("Test").expect("Neuaufbau");
        assert!(d.awaiting_keyframe, "nach dem Neuaufbau fehlt der Einstiegspunkt wieder");
        assert_eq!(d.skipped_before_keyframe, 0, "Zaehler gehoert zum neuen Anlauf");
    }

    /// Der Neuaufbau muss auf Software gehen — waere Hardware erlaubt, liefe
    /// er in denselben defekten CUDA-Kontext zurueck.
    #[test]
    fn neuaufbau_landet_auf_software() {
        let mut d = VideoDecoder::new(Codec::H264, Some(false)).expect("Software-Decoder");
        d.consecutive_errors = ERROR_LIMIT;
        d.rebuild("Test").expect("Neuaufbau");
        assert!(!d.hardware, "Neuaufbau muss Software sein, ist {}", d.name);
        assert_eq!(d.consecutive_errors, 0, "Zaehler muss fuer die Anlaufphase zurueckgesetzt sein");
        assert_eq!(d.rebuilds, 1);
    }

    /// Der Software-Weg muss auf jeder Maschine funktionieren — ohne den
    /// waere der Player auf fremder Hardware wertlos.
    #[test]
    fn software_decoder_laesst_sich_oeffnen() {
        let d = VideoDecoder::new(Codec::H264, Some(false));
        assert!(d.is_ok(), "H.264-Software-Decoder fehlt: {:?}", d.err());
        assert!(!d.unwrap().hardware);
    }
}
