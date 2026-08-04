//! Video-Decode ueber FFmpeg, Hardware zuerst.
//!
//! Hintergrund (gemessen 2026-07-26 auf der Dev-Maschine): Chromium nutzt auf
//! Linux/NVIDIA **kein** NVDEC — weder fuer H.264 noch fuer AV1, auch nicht mit
//! den ueblichen VA-API-Flags. `nvidia-smi dmon` zeigte durchgehend 0 % im
//! `dec`-Zaehler bei ~46 % CPU-Last eines Kerns. Dieser Player waehlt den
//! Decoder deshalb **explizit** statt zu hoffen.
//!
//! Vorgehen: erst einen hardwaregestuetzten Decoder ueber seinen Namen suchen
//! (`av1_cuvid`, `h264_cuvid`, `*_qsv`) oder den nativen mit angehaengtem
//! Geraet (VAAPI unter Linux, D3D11VA unter Windows), sonst Software. Die
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

/// Erkennt am Decoder-Namen, ob er selbst auf der GPU laeuft.
///
/// Gilt ausdruecklich NICHT fuer die hwaccel-Wege: die laufen ueber den
/// nativen Decoder mit angehaengtem Geraet, ihr Name ist deshalb schlicht
/// `av1` und sagt ueber die Hardware nichts. Dafuer steht [`Kandidat::hw`].
fn is_hardware(name: &str) -> bool {
    ["cuvid", "qsv"].iter().any(|tag| name.contains(tag))
}

/// Ein Geraetetyp, der an den NATIVEN Decoder gehaengt wird, statt einen
/// eigenen Decoder zu benennen.
///
/// Beides sind hwaccels, keine Decoder — genau die Verwechslung, an der die
/// Kandidatenliste bis 2026-08-01 mit erfundenen `av1_vaapi`-Namen scheiterte.
/// Die zwei Werte decken je eine Plattform ab: VAAPI unter Linux, D3D11VA
/// unter Windows.
// Je Zielplattform ist genau EINE Variante in Gebrauch — die andere ist dort
// tot, ohne dass etwas fehlt. Beide trotzdem hier zu fuehren haelt die
// Fallunterscheidung an einer Stelle statt in `#[cfg]`-Zweigen quer durchs Modul.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Hwaccel {
    Vaapi,
    D3d11va,
}

impl Hwaccel {
    fn geraetetyp(self) -> ffmpeg::ffi::AVHWDeviceType {
        match self {
            Self::Vaapi => ffmpeg::ffi::AVHWDeviceType::AV_HWDEVICE_TYPE_VAAPI,
            Self::D3d11va => ffmpeg::ffi::AVHWDeviceType::AV_HWDEVICE_TYPE_D3D11VA,
        }
    }

    fn beschreibung(self) -> &'static str {
        match self {
            Self::Vaapi => "Hardware (VAAPI)",
            Self::D3d11va => "Hardware (D3D11VA)",
        }
    }
}

/// Ein Weg, den Decoder zu oeffnen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Kandidat {
    /// Name des FFmpeg-Decoders.
    name: &'static str,
    /// Ein Hardware-Geraet anhaengen. Der Decode laeuft dann auf der GPU,
    /// obwohl `name` ein Software-Name ist.
    hw: Option<Hwaccel>,
}

impl Kandidat {
    const fn sw(name: &'static str) -> Self {
        Self { name, hw: None }
    }

    /// Der plattform-eigene hwaccel auf dem nativen Decoder.
    ///
    /// Bewusst EINE Funktion statt zweier Listen: die Reihenfolge der
    /// Kandidaten ist ueberall dieselbe, nur der Geraetetyp unterscheidet sich.
    const fn nativ_hw(name: &'static str) -> Self {
        #[cfg(windows)]
        let hw = Some(Hwaccel::D3d11va);
        #[cfg(not(windows))]
        let hw = Some(Hwaccel::Vaapi);
        Self { name, hw }
    }

    fn hardware(&self) -> bool {
        self.hw.is_some() || is_hardware(self.name)
    }

    fn beschreibung(&self) -> &'static str {
        match self.hw {
            Some(hw) => hw.beschreibung(),
            None if is_hardware(self.name) => "Hardware",
            None => "Software",
        }
    }
}

/// Aufeinanderfolgende abgelehnte Einheiten, ab denen der Decoder als defekt
/// gilt. Bei 60 fps ist das eine halbe Sekunde.
const ERROR_LIMIT: u32 = 30;

/// Wie viele Einheiten auf einen Einstiegspunkt gewartet wird, bevor die
/// Sitzung aufgibt. Bei 60 fps sind das zwanzig Sekunden.
///
/// Es MUSS eine Grenze geben: kommt nie ein Keyframe, waere stilles Warten
/// wieder genau das Verhalten, das eine Kachel dauerhaft in "verbinde"
/// stehen laesst — nur mit einer anderen Ursache.
///
/// 600 (zehn Sekunden) war zu knapp und hat am 2026-07-28 drei Sitzungen
/// gekostet: unter anhaltendem Paketverlust kommt ein angefordertes Vollbild
/// oft selbst beschaedigt an (25-35 Pakete, bei 5 % Verlust ~28 %
/// Ueberlebenswahrscheinlichkeit), die Uhr lief ab und der Player gab auf,
/// waehrend die Leitung sich kurz darauf erholte. Die Meldung benannte die
/// Ursache korrekt ("der Sender schickt zu selten ein Vollbild") — sie ging
/// nur unter, weil der Pruefstand die Player-Ereignisse nicht mitschrieb.
const MAX_UNITS_WITHOUT_KEYFRAME: u64 = 1200;

/// Ab wie vielen unveraenderten Bildern in Folge der Decoder als eingefroren
/// gilt. 90 sind bei 60 Bildern je Sekunde anderthalb Sekunden — lang genug,
/// dass eine kurze Standbild-Szene (Ladebildschirm, Standbild im Spiel) nicht
/// hineinlaeuft, kurz genug, dass ein Zuschauer nicht minutenlang festhaengt.
const EINFRIER_BILDER: u32 = 90;

/// Wie viele Bytes in derselben Zeit hineingegangen sein muessen. Ein echtes
/// Standbild kostet den Encoder fast nichts (wenige hundert Byte je Bild);
/// 500 kB ueber anderthalb Sekunden entspricht rund 2,7 Mbit/s und kommt nur
/// zustande, wenn wirklich Bildinhalt gesendet wird.
const EINFRIER_BYTES: usize = 500_000;

/// Fingerabdruck eines Bildes — billige Stichprobe statt vollem Vergleich.
///
/// Ein 1440p-Bild in 10 bit sind rund 11 MB; die bei jedem Bild vollstaendig
/// zu hashen waere teurer als das Dekodieren. Gelesen wird deshalb jedes
/// 1021. Byte (Primzahl, damit die Schrittweite nicht mit der Zeilenlaenge
/// zusammenfaellt und immer dieselbe Bildspalte trifft), hoechstens 4096
/// Proben. Fuer die Frage „hat sich ueberhaupt etwas geaendert" genuegt das:
/// zwei verschiedene Bilder stimmen an allen Proben nur zufaellig ueberein.
fn bild_abdruck(planes: &[Vec<u8>]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for plane in planes {
        plane.len().hash(&mut h);
        for (i, b) in plane.iter().step_by(1021).enumerate() {
            if i >= 4096 {
                break;
            }
            b.hash(&mut h);
        }
    }
    h.finish()
}

/// Wie oft neu aufgebaut wird, bevor die Sitzung als gescheitert gilt.
const MAX_REBUILDS: u32 = 2;

/// Wie lange das Bild nach einer Luecke als unsauber gilt — also die Dauer
/// eines vollen Auffrisch-Durchlaufs beim Sender.
///
/// Der Sender leitet sie aus seinem Keyframe-Abstand ab (`intraRefreshCnt =
/// gopLength - 1`, Vorgabe 2 s). Der Zuschauer kann sie NICHT aus dem
/// Datenstrom lesen: H.264 traegt dafuer eine Markierung, AV1 hat keine, und
/// NVIDIAs AV1-Konfiguration kennt das Feld gar nicht erst. Statt daran zu
/// scheitern, wird die Zeit einfach abgewartet — sie ist bekannt.
///
/// Zu kurz gewaehlt zeigt man Artefakte, zu lang ein Standbild, das laenger
/// steht als noetig. Die Vorgabe passt zur Sender-Vorgabe; weicht die ab,
/// setzt `PULSE_PLAYER_REFRESH_MS` sie nach.
fn refresh_dauer() -> std::time::Duration {
    let ms = std::env::var("PULSE_PLAYER_REFRESH_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|ms| (100..=10_000).contains(ms))
        .unwrap_or(2000);
    std::time::Duration::from_millis(ms)
}

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
///
/// **Hier stand bis 2026-08-01 `av1_vaapi` bzw. `h264_vaapi` — Decoder, die es
/// in FFmpeg NICHT GIBT.** VAAPI ist kein eigener Decoder, sondern ein hwaccel
/// auf dem nativen; die Namen liefen deshalb immer ins Leere. Auf einer
/// AMD-Karte fiel der Player damit still auf Software zurueck, obwohl die GPU
/// AV1 dekodieren kann (`vainfo`: `VAProfileAV1Profile0/VAEntrypointVLD`, 8
/// UND 10 bit). Gemessen am 2026-08-01 auf einer Radeon 780M.
///
/// **Warum der hwaccel vor QSV steht:** `av1_qsv` laesst sich auch ohne
/// Intel-Hardware oeffnen und scheitert erst beim ersten Bild — der Player
/// verliert dadurch eine halbe Sekunde und einen Neuaufbau (am 2026-08-01 im
/// Log beobachtet: „Decoder av1_qsv lehnt dauerhaft ab"). Das Anlegen des
/// Geraets scheitert dagegen sofort und sauber, wenn keine passende GPU da
/// ist. Auf Intel bedient derselbe hwaccel dieselbe Hardware.
///
/// **Unter Windows steht dort D3D11VA statt VAAPI** (seit 2026-08-04). VAAPI
/// gibt es dort nicht, die Liste war also Linux-foermig: der einzige Weg, der
/// sich ueberhaupt oeffnen liess, war `*_qsv` — auf einer AMD-Maschine der
/// falsche. Im Log vom 2026-08-04 ist genau das zu sehen, hundertfach
/// „Error creating a MFX session: -9", danach Software-Decode; die Radeon lag
/// waehrenddessen still, obwohl sie AV1 in 8 UND 10 bit kann.
fn candidates(codec: Codec, allow_hw: bool) -> Vec<Kandidat> {
    let (hw, sw): (&[Kandidat], &[Kandidat]) = match codec {
        Codec::Av1 => (
            &[
                Kandidat::sw("av1_cuvid"),
                Kandidat::nativ_hw("av1"),
                Kandidat::sw("av1_qsv"),
            ],
            &[Kandidat::sw("libdav1d"), Kandidat::sw("av1")],
        ),
        Codec::H264 => (
            &[
                Kandidat::sw("h264_cuvid"),
                Kandidat::nativ_hw("h264"),
                Kandidat::sw("h264_qsv"),
            ],
            // Nativer Decoder zuerst, `libopenh264` nur als Rueckfall.
            //
            // Der Rueckfall existiert, weil Distributionen die patentbehafteten
            // Decoder ausbauen (Fedora `libavcodec-free`,
            // `--disable-decoder='h264,hevc,vc1,vvc'`): dort gibt es `h264`
            // nicht, und ohne diesen Eintrag ist H.264-Wiedergabe schlicht
            // unmoeglich.
            //
            // **Die Reihenfolge ist nicht beliebig.** Am 2026-08-01 stand
            // `libopenh264` zuerst, und ein Messlauf mit unserem eigenen Strom
            // (High Profile, CABAC) lief damit ins Leere: 12-13 dekodierte
            // Bilder je Sekunde statt 60, 78-101 ms Dekodierzeit je Bild,
            // Ausgabe-Abstaende bis 1103 ms, dazu OpenH264-Warnungen. Der
            // native Decoder macht dieselbe Arbeit in wenigen Millisekunden.
            // OpenH264 ist auf Constrained Baseline ausgelegt — als Notnagel
            // richtig, als erste Wahl falsch.
            &[Kandidat::sw("h264"), Kandidat::sw("libopenh264")],
        ),
        Codec::Opus => (&[], &[Kandidat::sw("libopus"), Kandidat::sw("opus")]),
    };
    let mut out = Vec::new();
    if allow_hw {
        out.extend_from_slice(hw);
    }
    out.extend_from_slice(sw);
    out
}

/// Hardware-Dekodierung benutzen, wenn der Aufrufer nichts dazu gesagt hat?
///
/// Vorgabe ja; `PULSE_PLAYER_HWDEC=0` schaltet sie ab. Die Option gibt es im
/// Wire-Protokoll laengst (`OpenOptions.hwdec`), nur setzt sie niemand — und
/// fuer den Fall, um den es hier geht, waere sie an der falschen Stelle: er
/// haengt an der MASCHINE, nicht an der Sitzung.
///
/// **Wofuer man das braucht.** Auf AMD-APUs (Phoenix/VCN 4, z. B. Radeon 780M)
/// teilen sich Encode und Decode dieselbe Einheit. Sendet dieselbe Maschine,
/// auf der auch der Player laeuft, ueberlaeuft der Ring und der Treiber setzt
/// die GPU zurueck — `amdgpu: The CS has cancelled because the context is
/// lost`, danach ist der Player-Prozess weg (SIGABRT, am 2026-08-03 hier
/// beobachtet).
///
/// **KORREKTUR 2026-08-04: das gleichzeitige Encodieren ist NICHT noetig.**
/// Hier stand, das treffe „im Betrieb kaum jemanden (wer zusieht, sendet meist
/// nicht)". Am 2026-08-04 ist der Player unter Buendelverlust gestorben,
/// waehrend der Sender ein `ffmpeg -c copy` von der Platte war — nichts
/// encodierte. Der Kernel: `ring vcn_unified_0 timeout, signaled seq=242587,
/// emitted seq=242588`, also EIN Decodier-Auftrag, der nie zurueckkam. Es
/// trifft damit normale Zuschauer auf AMD bei schlechter Leitung, und der
/// Player wird seit dem 2026-08-03 im Flatpak ausgeliefert.
///
/// **Abfangen laesst es sich hier NICHT.** Der Coredump zeigt `abort()` in
/// `amdgpu_ctx_set_sw_reset_status` auf Mesas eigenem Submit-Thread
/// (`util_queue_thread_func`) — kein Rueckgabewert, kein Panic, nichts, was
/// dieser Prozess sehen koennte. Der Rettungsweg gehoert deshalb in den
/// Aufseher (`desktop/electron/player.ts`, `exit`-Handler): SIGABRT erkennen
/// und einmalig mit `PULSE_PLAYER_HWDEC=0` neu starten. Bewusst noch nicht
/// gebaut, s. `streaming/hq-labor/CLAUDE.md`.
///
/// Ohne gleichzeitiges Encoden dekodiert dieselbe Karte mit rund 185 fps.
///
/// Software-Dekodierung ist dafuer nur brauchbar, wenn `libdav1d` im
/// FFmpeg-Bau steckt — der native AV1-Decoder ist um ein Vielfaches langsamer.
/// `streaming/ffmpeg-patches/bootstrap-ffmpeg.sh` schaltet es deshalb ein.
fn hwdec_vorgabe() -> bool {
    !matches!(std::env::var("PULSE_PLAYER_HWDEC").as_deref(), Ok("0"))
}

/// Welche Render-Node der VAAPI-Weg benutzt.
///
/// Ueber `PULSE_PLAYER_VAAPI_DEVICE` umstellbar — auf Maschinen mit zwei GPUs
/// (iGPU plus Steckkarte) ist die erste nicht zwingend die richtige.
fn vaapi_geraetepfad() -> String {
    std::env::var("PULSE_PLAYER_VAAPI_DEVICE")
        .unwrap_or_else(|_| "/dev/dri/renderD128".to_string())
}

/// Haengt ein Hardware-Geraet an den Decoder-Kontext, VOR dem Oeffnen.
///
/// **Mehr braucht es nicht.** `avcodec_default_get_format` waehlt das
/// Hardware-Format von sich aus, sobald ein Geraet gesetzt ist und der Decoder
/// eine passende hwaccel-Konfiguration hat — nachgelesen in
/// `libavcodec/decode.c` („If a device was supplied when the codec was opened,
/// assume that the user wants to use it"). Ein eigener `get_format`-Rueckruf
/// waere ein Funktionszeiger aus Rust in FFmpeg hinein und damit deutlich mehr
/// Angriffsflaeche fuer denselben Effekt.
///
/// Die Referenz auf das Geraet geht an den Kontext ueber; `avcodec_free_context`
/// gibt sie frei.
fn hw_geraet_anhaengen(ctx: *mut ffmpeg::ffi::AVCodecContext, art: Hwaccel) -> Result<()> {
    // Nur VAAPI braucht einen Pfad. D3D11VA waehlt ohne Angabe den
    // Standard-Adapter — auf einer Maschine mit zwei GPUs also denselben, den
    // auch der Rest des Systems benutzt.
    let pfad = match art {
        Hwaccel::Vaapi => Some(vaapi_geraetepfad()),
        Hwaccel::D3d11va => None,
    };
    let c_pfad = pfad
        .as_deref()
        .map(std::ffi::CString::new)
        .transpose()
        .context("Geraetepfad")?;
    let mut geraet: *mut ffmpeg::ffi::AVBufferRef = std::ptr::null_mut();
    // SAFETY: `ctx` ist ein frisch angelegter, noch nicht geoeffneter Kontext;
    // `c_pfad` lebt bis zum Ende des Aufrufs. `av_hwdevice_ctx_create` schreibt
    // ausschliesslich in `geraet`.
    let rc = unsafe {
        ffmpeg::ffi::av_hwdevice_ctx_create(
            &mut geraet,
            art.geraetetyp(),
            c_pfad.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
            std::ptr::null_mut(),
            0,
        )
    };
    if rc < 0 || geraet.is_null() {
        let wo = pfad.as_deref().unwrap_or("Standard-Adapter");
        bail!("{} auf {wo} liess sich nicht anlegen (rc={rc})", art.beschreibung());
    }
    // SAFETY: `ctx` ist gueltig und ungeoeffnet; das Feld war zuvor null.
    unsafe { (*ctx).hw_device_ctx = geraet };
    Ok(())
}

/// Holt ein Bild aus dem Grafikspeicher in den Hauptspeicher.
///
/// **Das Zielformat gibt FFmpeg vor** (`format` bleibt ungesetzt): bei 8 bit
/// kommt NV12 heraus, bei 10 bit P010 — beides kennt [`convert`]. Ein festes
/// Format zu verlangen hiesse, den 10-bit-Fall stillschweigend auf 8 bit zu
/// stutzen; genau die Sorte Verlust, die niemandem auffaellt.
///
/// **`av_hwframe_transfer_data` kopiert nur die Bilddaten.** Farbraum,
/// Wertebereich und Zeitstempel muessen getrennt mit — ohne sie raet `convert`
/// die Matrix (das war am 2026-07-26 schon einmal zwei Fehlversuche wert) und
/// die Latenzmessung verliert ihren Bezugspunkt.
///
/// **`ziel` wird wiederverwendet.** FFmpeg legt die Puffer nur an, wenn keine
/// da sind (`hwcontext.c`: `if (!dst->buf[0]) return transfer_data_alloc(…)`)
/// — sonst schreibt es hinein. Ein frisches Bild je Durchgang waeren bei
/// 1440p10 rund 11 MB Anforderung sechzigmal je Sekunde, also genau die Last,
/// gegen die es den [`PlanePool`] gibt. Aendert sich Format oder Groesse,
/// scheitert der Transfer in den alten Puffer; dann wird einmal neu angelegt.
fn in_den_hauptspeicher(
    gpu: &ffmpeg::util::frame::video::Video,
    ziel: &mut ffmpeg::util::frame::video::Video,
) -> Result<()> {
    // SAFETY: beide Bilder sind gueltig und gehoeren uns; FFmpeg schreibt
    // ausschliesslich in `ziel`.
    let mut rc = unsafe { ffmpeg::ffi::av_hwframe_transfer_data(ziel.as_mut_ptr(), gpu.as_ptr(), 0) };
    if rc < 0 {
        *ziel = ffmpeg::util::frame::video::Video::empty();
        // SAFETY: wie oben, nur mit leerem Ziel — FFmpeg legt Puffer und
        // Format jetzt selbst fest.
        rc = unsafe { ffmpeg::ffi::av_hwframe_transfer_data(ziel.as_mut_ptr(), gpu.as_ptr(), 0) };
    }
    if rc < 0 {
        bail!("av_hwframe_transfer_data scheiterte (rc={rc})");
    }
    // SAFETY: wie oben; kopiert nur Metadaten.
    let rc = unsafe { ffmpeg::ffi::av_frame_copy_props(ziel.as_mut_ptr(), gpu.as_ptr()) };
    if rc < 0 {
        bail!("av_frame_copy_props scheiterte (rc={rc})");
    }
    Ok(())
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
        format: PixelLayout,
    ) -> Self {
        Self {
            width,
            height,
            format,
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
    /// Bis wann das Bild nach einer Luecke als unsauber gilt (s. [`on_gap`]).
    unsauber_bis: Option<std::time::Instant>,
    /// Fingerabdruck des zuletzt ausgegebenen Bildes und wie oft er sich in
    /// Folge NICHT geaendert hat — der Einfrier-Nachweis (s.
    /// [`VideoDecoder::eingefroren`]).
    letzter_abdruck: Option<u64>,
    gleiche_bilder: u32,
    /// Bytes, die seit dem letzten ausgegebenen Bild hineingegangen sind.
    /// Trennt „der Schirm steht, weil nichts Neues gesendet wird" von „der
    /// Decoder gibt trotz voller Datenrate immer dasselbe aus".
    bytes_seit_bild: usize,
    /// Wie viele Vollbilder bisher ankamen, und wann das letzte kam —
    /// gemeldet, weil der Abstand verraet, ob sich zwei Keyframe-Quellen
    /// ueberlagern (Sender-Takt plus Server-Uhr).
    keyframes: u64,
    letztes_keyframe: Option<std::time::Instant>,
    /// Vorrat fuer die Ebenen-Puffer (s. [`PlanePool`]). Ueberlebt den
    /// Neuaufbau des Decoders, weil die Puffergroessen dieselben bleiben.
    plane_pool: PlanePool,
    /// Wiederverwendetes Ziel fuer den Weg von der GPU in den Hauptspeicher
    /// (s. [`in_den_hauptspeicher`]). Nur auf dem VAAPI-Weg benutzt.
    hw_ziel: ffmpeg::util::frame::video::Video,
}

impl VideoDecoder {
    /// Legt einen Decoder an. `allow_hw = None` bedeutet automatisch.
    pub fn new(codec: Codec, allow_hw: Option<bool>) -> Result<Self> {
        ffmpeg::init().context("FFmpeg-Initialisierung")?;
        if !codec.is_video() {
            bail!("{} ist kein Video-Codec", codec.as_str());
        }
        let allow = allow_hw.unwrap_or_else(hwdec_vorgabe);

        let mut last_err = None;
        for kandidat in candidates(codec, allow) {
            match Self::try_open(kandidat) {
                Ok(decoder) => {
                    let hardware = kandidat.hardware();
                    eprintln!(
                        "pulse-player: Decoder {} ({})",
                        kandidat.name,
                        kandidat.beschreibung()
                    );
                    return Ok(Self {
                        decoder,
                        name: kandidat.name.to_string(),
                        hardware,
                        codec,
                        consecutive_errors: 0,
                        rebuilds: 0,
                        awaiting_keyframe: true,
                        skipped_before_keyframe: 0,
                        unsauber_bis: None,
                        letzter_abdruck: None,
                        gleiche_bilder: 0,
                        bytes_seit_bild: 0,
                        keyframes: 0,
                        letztes_keyframe: None,
                        plane_pool: PlanePool::default(),
                        hw_ziel: ffmpeg::util::frame::video::Video::empty(),
                    });
                }
                Err(e) => last_err = Some(e),
            }
        }
        Err(last_err.unwrap_or_else(|| anyhow!("kein Decoder fuer {}", codec.as_str())))
    }

    fn try_open(kandidat: Kandidat) -> Result<ffmpeg::decoder::Video> {
        let name = kandidat.name;
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
        if let Some(art) = kandidat.hw {
            // SAFETY: der Kontext gehoert uns, ist frisch angelegt und noch
            // nicht geoeffnet; `hw_geraet_anhaengen` setzt genau ein Feld.
            let ptr = unsafe { ctx.as_mut_ptr() };
            hw_geraet_anhaengen(ptr, art)
                .with_context(|| format!("{} fuer {name}", art.beschreibung()))?;
        }
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
        // Die Anzeigesperre nach einer Luecke endet, sobald das angeforderte
        // Vollbild WIRKLICH da ist — nicht nach einer geschaetzten Zeit. Der
        // Zeitdeckel in `on_gap` bleibt nur als Notausgang, damit ein
        // ausbleibendes Vollbild das Bild nicht fuer immer sperrt.
        if crate::recorder::is_keyframe(self.codec, data) {
            self.unsauber_bis = None;
            // Abstand der ankommenden Vollbilder melden. Beantwortet zwei
            // Fragen, die man sonst nur raten kann: ob der Sender ueberhaupt
            // welche schickt, und ob sich ZWEI Quellen ueberlagern — der
            // eigene Takt des Senders und die Uhr im Server erzeugen sonst
            // unbemerkt doppelt so viele Stoesse wie noetig.
            let jetzt = std::time::Instant::now();
            self.keyframes += 1;
            let abstand = self
                .letztes_keyframe
                .map(|t: std::time::Instant| format!("{:.0} ms", jetzt.duration_since(t).as_millis()))
                .unwrap_or_else(|| "erstes".to_string());
            self.letztes_keyframe = Some(jetzt);
            eprintln!(
                "pulse-player: Vollbild #{} empfangen, Abstand {abstand}",
                self.keyframes
            );
        }
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

        // Zaehlt mit, wieviel Bildinhalt seit dem letzten VERAENDERTEN Bild
        // hineingegangen ist — die zweite Haelfte des Einfrier-Nachweises.
        self.bytes_seit_bild = self.bytes_seit_bild.saturating_add(data.len());

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
        // Weiterdekodieren und die Anzeige anhalten, bis das angeforderte
        // Vollbild da ist. Die Sperre versteckt die Zerfledderung — sie
        // ERSETZT das Vollbild NICHT.
        //
        // Genau das war der Irrtum vom 2026-07-28: Die Annahme, ein Strom mit
        // wandernder Auffrischung repariere sich binnen eines Durchlaufs von
        // selbst, sodass niemand mehr etwas anfordern muesste. Am laufenden
        // Stream widerlegt — nach einem Aussetzer liefert `av1_cuvid` weiter
        // 60 Bilder je Sekunde, aber immer dasselbe. Das Bild fror ein und
        // BLIEB eingefroren, waehrend jede Kennzahl gesund aussah. Wer sich
        // auf die Zaehler verlaesst, haelt das fuer einen Erfolg.
        //
        // Der Decoder wird dabei NICHT geleert: ein geleerter Decoder hat gar
        // keine Referenz mehr und kann nichts mehr rechnen. Am 2026-07-28
        // gemessen — mit `flush` an dieser Stelle blieb die Bildrate bei 0.
        if std::env::var("PULSE_PLAYER_GAP_WAIT_KEYFRAME").as_deref() != Ok("1") {
            let bis = std::time::Instant::now() + refresh_dauer();
            // Eine laengere Stoerung erzeugt viele Luecken hintereinander —
            // immer die spaeteste gewinnt, sonst gaebe die erste den Takt vor.
            self.unsauber_bis = Some(match self.unsauber_bis {
                Some(alt) if alt > bis => alt,
                _ => bis,
            });
            return;
        }

        // Alter Weg (`PULSE_PLAYER_GAP_WAIT_KEYFRAME=1`): auf einen
        // Einstiegspunkt warten. Dann den Decoder LEEREN, nicht nur aufhoeren
        // ihn zu fuettern.
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

    /// Wartet der Decoder noch auf seinen ersten Einstiegspunkt?
    ///
    /// **Warum das nach aussen muss.** Ohne Einstieg verwirft er JEDE Einheit
    /// (s. [`VideoDecoder::decode`]) — der Zuschauer sieht nichts. Im
    /// Intra-Refresh-Betrieb gibt es aber keinen regulaeren Keyframe mehr: das
    /// einzige Vollbild kommt auf Anforderung. Geht die eine Anforderung
    /// hinaus, waehrend der Player noch im Verbindungsaufbau steckt, wartet er
    /// danach VERGEBLICH — bis `MAX_UNITS_WITHOUT_KEYFRAME` die Sitzung
    /// abbricht. Am 2026-07-31 im Pruefstand beobachtet: 150 Sekunden mit
    /// „dekodiert 0/s", ohne dass ein zweites Mal angefordert wurde.
    ///
    /// Die Sitzung fragt das ab und fordert nach, solange es `true` ist.
    pub fn wartet_auf_einstieg(&self) -> bool {
        self.awaiting_keyframe
    }

    /// Liefert der Decoder trotz voller Datenrate immer dasselbe Bild?
    ///
    /// **Warum es das braucht.** `av1_cuvid` kippt nach einem Aussetzer in
    /// einen Zustand, in dem er weiter 60 Bilder je Sekunde ausgibt — immer
    /// dasselbe (s. [`VideoDecoder::on_gap`], dort seit dem 2026-07-28
    /// beschrieben). Dagegen gibt es eine Rettung: Anzeige sperren, Decoder
    /// leeren, Vollbild anfordern. Sie haengt aber ausschliesslich an der
    /// Lueckenmeldung des Jitter-Puffers.
    ///
    /// **Und genau die bleibt im gemessenen Fall aus.** Am 2026-07-31
    /// reproduziert (`profiles/player-2026-07-31-einfrieren-ohne-verlust.json`):
    /// nach dem Ende einer Saettigungsphase fror das Bild ein und blieb es
    /// ueber 90 Sekunden, bei **null verlorenen Paketen** — im Mitschnitt
    /// fehlte keine einzige Sequenznummer, und der Zusammensetzer baute aus
    /// denselben Paketen nachweislich einen fehlerfreien Bitstrom (16556
    /// Einheiten, keine strukturelle Abweichung). Kein Verlust heisst keine
    /// Luecke, keine Luecke heisst keine Rettung.
    ///
    /// Der Nachweis kommt deshalb aus dem Ergebnis statt aus der Ursache: Wenn
    /// ueber eine Sekunde lang jedes Bild denselben Fingerabdruck traegt,
    /// waehrend ordentlich Daten hineingehen, rechnet der Decoder nicht mehr.
    /// Ein echtes Standbild sieht anders aus — dort schickt der Encoder
    /// winzige Bilder, weil sich nichts aendert; deshalb die Byte-Schwelle.
    pub fn eingefroren(&mut self) -> bool {
        if self.gleiche_bilder < EINFRIER_BILDER || self.bytes_seit_bild < EINFRIER_BYTES {
            return false;
        }
        // Zuruecksetzen, sonst meldet jeder folgende Durchgang erneut und der
        // Aufrufer schickt im Sekundentakt Vollbild-Anforderungen.
        self.gleiche_bilder = 0;
        self.bytes_seit_bild = 0;
        self.letzter_abdruck = None;
        true
    }

    /// Setzt den Decoder nach einem erkannten Einfrieren neu auf.
    ///
    /// Wie der Keyframe-Zweig von [`on_gap`]: leeren und auf den naechsten
    /// Einstiegspunkt warten. Ohne das Leeren rechnet er auf demselben kaputten
    /// Zustand weiter, den wir gerade festgestellt haben.
    pub fn wegen_einfrieren_neu(&mut self) {
        eprintln!(
            "pulse-player: Decoder eingefroren (gleiches Bild trotz Daten) — \
             leere ihn und fordere ein Vollbild an"
        );
        self.decoder.flush();
        self.unsauber_bis = None;
        if !self.awaiting_keyframe {
            self.awaiting_keyframe = true;
            self.skipped_before_keyframe = 0;
        }
    }

    /// Darf das, was gerade herausfaellt, gezeigt werden?
    ///
    /// Nach einer Luecke rechnet der Decoder auf einem Referenzbild weiter,
    /// dem Teile fehlen — die Bilder sind brauchbar zum Weiterrechnen, aber
    /// nicht zum Anschauen. Wer sie trotzdem anzeigt, sieht Bildmuell; wer
    /// stattdessen gar nichts schickt, laesst das letzte gute Bild stehen.
    /// Letzteres ist die bessere Antwort — und die einzige, die keine
    /// Anforderung an den Sender braucht.
    pub fn ist_sauber(&mut self) -> bool {
        match self.unsauber_bis {
            None => true,
            Some(bis) if std::time::Instant::now() >= bis => {
                self.unsauber_bis = None;
                true
            }
            Some(_) => false,
        }
    }

    fn drain(&mut self) -> Vec<DecodedFrame> {
        let mut out = Vec::new();
        let mut frame = ffmpeg::util::frame::video::Video::empty();
        while self.decoder.receive_frame(&mut frame).is_ok() {
            // Auf den hwaccel-Wegen liegt das Bild im Grafikspeicher; der
            // Renderer erwartet Ebenen im Hauptspeicher. Genau wie bei cuvid,
            // das seine Bilder von sich aus herunterreicht — nur muss man es
            // hier selbst tun.
            //
            // **Beide Formate MUESSEN hier stehen.** Als am 2026-08-04 der
            // D3D11VA-Weg dazukam, stand er hier zunaechst nicht — mit der
            // Folge, dass der Decoder sauber lieferte, `convert` aber jedes
            // Bild mit "Pixelformat D3D11 wird nicht unterstuetzt" ablehnte
            // und nie eines beim Renderer ankam: ein weisses Fenster, ohne
            // dass irgendwo ein Fehler stand, der nach der Ursache aussieht.
            // Wer einen dritten Geraetetyp ergaenzt, ergaenzt ihn auch hier.
            let auf_gpu = matches!(
                frame.format(),
                ffmpeg::format::Pixel::VAAPI | ffmpeg::format::Pixel::D3D11
            );
            if auf_gpu {
                if let Err(e) = in_den_hauptspeicher(&frame, &mut self.hw_ziel) {
                    eprintln!("pulse-player: Bild von der GPU holen scheiterte: {e}");
                    continue;
                }
            }
            // Eigener Block: die Leihe auf `self.hw_ziel` endet hier, danach
            // darf der Zaehlerstand unten wieder veraendert werden.
            let umgewandelt = {
                let bild = if auf_gpu { &self.hw_ziel } else { &frame };
                convert(bild, &self.plane_pool)
            };
            if let Some(f) = umgewandelt {
                // Aendert sich der Bildinhalt ueberhaupt noch? (s.
                // [`VideoDecoder::eingefroren`])
                let abdruck = bild_abdruck(&f.planes);
                if self.letzter_abdruck == Some(abdruck) {
                    self.gleiche_bilder = self.gleiche_bilder.saturating_add(1);
                } else {
                    self.letzter_abdruck = Some(abdruck);
                    self.gleiche_bilder = 0;
                    self.bytes_seit_bild = 0;
                }
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

    /// Der Fingerabdruck muss zwei Dinge koennen: gleiche Bilder gleich
    /// abbilden und veraenderte verschieden. Er liest nur jedes 1021. Byte —
    /// die Probe MUSS also treffen, sonst meldet der Einfrier-Nachweis
    /// „unveraendert", waehrend sich das Bild sehr wohl aendert.
    #[test]
    fn abdruck_erkennt_veraenderung() {
        let a = vec![vec![7u8; 300_000], vec![9u8; 150_000]];
        assert_eq!(super::bild_abdruck(&a), super::bild_abdruck(&a.clone()));

        // Erste Probenstelle veraendern.
        let mut b = a.clone();
        b[0][0] = 8;
        assert_ne!(super::bild_abdruck(&a), super::bild_abdruck(&b));

        // Eine spaetere Probenstelle (jedes 1021. Byte).
        let mut c = a.clone();
        c[0][1021 * 50] = 8;
        assert_ne!(super::bild_abdruck(&a), super::bild_abdruck(&c));

        // Andere Groesse zaehlt ebenfalls als Veraenderung.
        let d = vec![vec![7u8; 299_999], vec![9u8; 150_000]];
        assert_ne!(super::bild_abdruck(&a), super::bild_abdruck(&d));
    }
    use super::*;

    #[test]
    fn kandidaten_enden_immer_auf_software() {
        let av1 = candidates(Codec::Av1, true);
        assert!(av1.first().unwrap().name.contains("cuvid"), "Hardware zuerst: {av1:?}");
        assert!(av1.iter().any(|k| k.name == "libdav1d"), "Software-Rueckfall fehlt: {av1:?}");
        assert!(!av1.last().unwrap().hardware(), "zuletzt Software: {av1:?}");

        let h264 = candidates(Codec::H264, true);
        assert!(h264.iter().any(|k| k.name == "h264"), "Software-Rueckfall fehlt: {h264:?}");
    }

    #[test]
    fn ohne_hardware_nur_software() {
        let list = candidates(Codec::Av1, false);
        assert!(
            !list.iter().any(|k| k.hardware()),
            "Hardware darf abschaltbar sein: {list:?}"
        );
    }

    /// VAAPI und D3D11VA sind keine eigenen Decoder, sondern Geraete am
    /// nativen — genau deshalb liefen die frueheren Namen
    /// `av1_vaapi`/`h264_vaapi` ins Leere. Der Kandidat muss den NATIVEN Namen
    /// tragen und trotzdem als Hardware zaehlen, sonst faellt der Player still
    /// auf Software zurueck.
    #[test]
    fn hwaccel_haengt_am_nativen_decoder() {
        for (codec, nativ) in [(Codec::Av1, "av1"), (Codec::H264, "h264")] {
            let liste = candidates(codec, true);
            let hw = liste.iter().find(|k| k.hw.is_some()).expect("hwaccel-Kandidat fehlt");
            assert_eq!(hw.name, nativ, "hwaccel muss den nativen Decoder nehmen");
            assert!(hw.hardware(), "hwaccel zaehlt als Hardware");

            // Und zwar VOR QSV, das sich auch ohne Intel-Hardware oeffnen
            // laesst und erst beim ersten Bild scheitert.
            let pos_hw = liste.iter().position(|k| k.hw.is_some()).unwrap();
            let pos_qsv = liste.iter().position(|k| k.name.contains("qsv")).unwrap();
            assert!(pos_hw < pos_qsv, "hwaccel vor QSV: {liste:?}");
        }
    }

    /// Der Geraetetyp MUSS zur Plattform passen. Stand hier der falsche, waere
    /// der einzige oeffenbare Hardware-Weg unter Windows wieder `*_qsv` — auf
    /// einer AMD-Maschine die falsche Hardware, und der Fehler faellt nur als
    /// halbe Sekunde Verzoegerung auf, nicht als Fehlermeldung.
    #[test]
    fn geraetetyp_passt_zur_plattform() {
        let hw = candidates(Codec::Av1, true)
            .into_iter()
            .find_map(|k| k.hw)
            .expect("hwaccel-Kandidat fehlt");
        #[cfg(windows)]
        assert_eq!(hw, Hwaccel::D3d11va);
        #[cfg(not(windows))]
        assert_eq!(hw, Hwaccel::Vaapi);
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

    /// Diagnose zum Befund vom 2026-07-29: 87 Mal "Error parsing OBU data" in
    /// einem Lauf OHNE Stoerung (null Luecken, null Paketverlust). Assembler
    /// und Einheiten sind bereits entlastet — dieselben Einheiten als Datei an
    /// libdav1d gegeben ergeben NULL Fehler. Uebrig bleibt die Einspeisung:
    /// der Player reicht jede Einheit einzeln herein, und der Depacketizer
    /// laesst dabei den Temporal Delimiter weg, den RTP nicht uebertraegt.
    ///
    /// Dieser Test faehrt genau den Player-Weg und vergleicht beide Varianten.
    /// `PULSE_PLAYER_UNITS_IN` zeigt auf die Datei, die
    /// `depacket::tests::echter_mitschnitt_ergibt_syntaktisch_heile_einheiten`
    /// schreibt; `PULSE_PLAYER_ADD_TD=1` stellt jeder Einheit einen Temporal
    /// Delimiter voran. Die Fehlerzeilen kommen aus FFmpeg selbst, also mit
    /// `-- --nocapture` laufen lassen und zaehlen.
    #[test]
    #[ignore = "Diagnose; braucht PULSE_PLAYER_UNITS_IN"]
    fn einheiten_durch_den_echten_decoder_weg() {
        let quelle = std::env::var("PULSE_PLAYER_UNITS_IN")
            .expect("PULSE_PLAYER_UNITS_IN muss auf die Einheiten-Datei zeigen");
        let mit_td = std::env::var("PULSE_PLAYER_ADD_TD").as_deref() == Ok("1");
        let roh = std::fs::read(&quelle).expect("Einheiten lesbar");

        // Beide Wege pruefbar: der Befund entscheidet sich daran, ob nur der
        // Software-Rueckfall betroffen ist oder auch der Normalbetrieb.
        let hw = std::env::var("PULSE_PLAYER_TEST_HW").as_deref() == Ok("1");
        let mut d = VideoDecoder::new(Codec::Av1, Some(hw)).expect("Decoder");
        // Gleiches Format wie ein .rtpdump (4-Byte-LE-Laenge + 1 Fuellbyte +
        // Nutzlast) — `echter_mitschnitt_ergibt_syntaktisch_heile_einheiten`
        // schreibt es genau so, das zweite Feld bleibt hier ungenutzt.
        let mut rein = 0usize;
        let mut bilder = 0usize;
        let mut verworfen = 0usize;
        for (unit, _) in crate::dump::read_dump(&roh) {
            let mut einheit = Vec::new();
            if mit_td {
                // OBU_TEMPORAL_DELIMITER (Typ 2) mit Groessenfeld, Laenge 0.
                einheit.extend_from_slice(&[0x12, 0x00]);
            }
            einheit.extend_from_slice(&unit);
            // Kennzeichnung VOR dem Einspeisen: FFmpegs Fehlerzeilen gehen auf
            // demselben Weg nach stderr, stehen also unmittelbar hinter der
            // Einheit, die sie ausgeloest hat. Nur so wird aus einer blossen
            // Anzahl eine Zuordnung — die Fehler kommen aus der Bibliothek und
            // nicht als Rueckgabewert, sie sind sonst keiner Einheit zuzuordnen.
            eprintln!(
                "EINHEIT {rein} laenge={} typ={}",
                unit.len(),
                unit.first().map_or(99, |b| (b >> 3) & 0x0F)
            );
            rein += 1;
            match d.decode(&einheit) {
                Ok(fs) if fs.is_empty() => verworfen += 1,
                Ok(fs) => bilder += fs.len(),
                Err(e) => panic!("Decoder endgueltig hin nach {rein} Einheiten: {e}"),
            }
        }
        eprintln!(
            "TD vorangestellt: {mit_td} | {rein} Einheiten rein, {bilder} Bilder raus, \
             {verworfen} ohne Ausgabe"
        );
        assert!(bilder > 0, "kein einziges Bild dekodiert");
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

    /// Sobald Sequence-Header UND Vollbild da sind, wird eingespeist.
    ///
    /// Der Header allein reichte hier bis 2026-08-02 — siehe
    /// `recorder::scan_av1_for_keyframe`: gegen einen Sender, der ihn auch
    /// ohne Vollbild schreibt, waere das ein Einstieg auf ein Zwischenbild.
    #[test]
    fn sequence_header_mit_vollbild_beendet_das_warten() {
        let mut d = VideoDecoder::new(Codec::Av1, Some(false)).expect("AV1-Software-Decoder");
        // OBU_SEQUENCE_HEADER (Typ 1) mit Groessenfeld.
        let seq = [0x0Au8, 0x02, 0x00, 0x00];
        let _ = d.decode(&seq);
        assert!(d.awaiting_keyframe, "der Header allein ist kein Einstiegspunkt");

        // Derselbe Header, gefolgt von OBU_FRAME (Typ 6) mit
        // `show_existing_frame = 0` und `frame_type = KEY_FRAME`.
        let mut einheit = seq.to_vec();
        einheit.extend([0x32u8, 0x03, 0x00, 0x00, 0x00]);
        let _ = d.decode(&einheit);
        assert!(!d.awaiting_keyframe, "Header samt Vollbild ist der Einstiegspunkt");
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
