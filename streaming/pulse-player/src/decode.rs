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
//! Geraet (VAAPI unter Linux, D3D11VA unter Windows), sonst Software. Der
//! Decode laeuft in allen diesen Faellen auf der GPU.
//!
//! **Hier stand „Das ist noch nicht zero-copy … bewusst nicht Teil des ersten
//! Wurfs". Das gilt fuer zwei Wege nicht mehr:** unter Windows bleibt das Bild
//! seit dem 2026-08-06 auf dem D3D11VA-Weg im Grafikspeicher, unter Linux seit
//! dem 2026-08-07 auf dem CUDA-Weg. Beide als VORGABE
//! (`PULSE_PLAYER_ZEROCOPY=0` schaltet sie aus — s. [`crate::zerocopy`]). Fuer
//! VAAPI gilt der Satz weiter: dort gibt es keine Bruecke.
//!
//! **Die cuvid-Decoder geben ihre Bilder auf der Karte heraus, seit sie ein
//! CUDA-Geraet bekommen (2026-08-07).** Bis dahin landeten sie im
//! Hauptspeicher, und die Begruendung dafuer stand hier falsch: es hiess, sie
//! taeten das von sich aus. Gemessen ist das Gegenteil — `av1_cuvid` und
//! `h264_cuvid` bieten `AV_PIX_FMT_CUDA` an und waehlen es, sobald am
//! Decoder-Kontext ein CUDA-Geraet haengt. Sie lieferten in den Hauptspeicher,
//! **weil dieser Code ihnen kein Geraet gab**. Die Rueckholung kostete 0,33 bis
//! 1,03 ms je Bild und sass unsichtbar in `send_packet`, nicht in
//! [`in_den_hauptspeicher`].
//! Beleg: `streaming/testbench/profiles/player-2026-08-07-cuvid-cuda-ausgabe.json`.
//!
//! LIZENZ: FFmpeg muss in ausgelieferten Builds LGPL-konfiguriert und dynamisch
//! gelinkt sein — siehe Cargo.toml und THIRD-PARTY-NOTICES.md.

use anyhow::{anyhow, bail, Context, Result};
use ffmpeg_next as ffmpeg;

use crate::einfrieren::EinfrierWacht;
use crate::neuaufbau::{self, ErrorAction, Neuaufbauten};
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
/// `Vaapi` und `D3d11va` sind hwaccels, keine Decoder — genau die Verwechslung,
/// an der die Kandidatenliste bis 2026-08-01 mit erfundenen `av1_vaapi`-Namen
/// scheiterte. Sie decken je eine Plattform ab: VAAPI unter Linux, D3D11VA
/// unter Windows.
///
/// **`Cuda` ist der Sonderfall und faellt aus der Reihe.** Es sitzt nicht auf
/// dem nativen Decoder, sondern auf `av1_cuvid`/`h264_cuvid` — die sind sehr
/// wohl eigene Decoder. Das Geraet steuert dort nicht, WER dekodiert, sondern
/// nur, WOHIN das Ergebnis geht: ohne Geraet in den Hauptspeicher, mit Geraet
/// in den Grafikspeicher (`AV_PIX_FMT_CUDA`).
// Je Zielplattform ist genau EINE der beiden hwaccel-Varianten in Gebrauch —
// die andere ist dort tot, ohne dass etwas fehlt. Beide trotzdem hier zu
// fuehren haelt die Fallunterscheidung an einer Stelle statt in
// `#[cfg]`-Zweigen quer durchs Modul.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Hwaccel {
    Vaapi,
    D3d11va,
    Cuda,
}

impl Hwaccel {
    fn geraetetyp(self) -> ffmpeg::ffi::AVHWDeviceType {
        match self {
            Self::Vaapi => ffmpeg::ffi::AVHWDeviceType::AV_HWDEVICE_TYPE_VAAPI,
            Self::D3d11va => ffmpeg::ffi::AVHWDeviceType::AV_HWDEVICE_TYPE_D3D11VA,
            Self::Cuda => ffmpeg::ffi::AVHWDeviceType::AV_HWDEVICE_TYPE_CUDA,
        }
    }

    fn beschreibung(self) -> &'static str {
        match self {
            Self::Vaapi => "Hardware (VAAPI)",
            Self::D3d11va => "Hardware (D3D11VA)",
            Self::Cuda => "Hardware (CUDA)",
        }
    }

    /// Das `flags`-Argument von `av_hwdevice_ctx_create`.
    ///
    /// **Fuer CUDA steht hier 0, und das ist heute richtig — aber nur heute.**
    /// Null heisst: FFmpeg legt sich einen EIGENEN Kontext an. Fuer VAAPI und
    /// D3D11VA ist das richtig — dort holt sich die Bruecke ihr Geraet aus dem
    /// Bild, statt eines vorzugeben.
    ///
    /// **Fuer CUDA haengt es davon ab, ob der Player selbst schon einen Kontext
    /// haelt** (`geteilter_kontext`). Haelt er einen — und das tut er, sobald
    /// die Zero-Copy-Bruecke moeglich ist —, muss hier
    /// `AV_CUDA_USE_CURRENT_CONTEXT` (Bit 1, also `2`) stehen: sonst hat der
    /// Prozess zwei Kontexte auf einer Karte, und `cuMemcpy2D` aus dem
    /// Decoder-Bild in unser Vulkan-Bild ginge ueber die Kontextgrenze, statt
    /// zu funktionieren.
    ///
    /// **`AV_CUDA_USE_PRIMARY_CONTEXT` (Bit 0, also `1`) ist an dieser Stelle
    /// der falsche Weg**, auch wenn der Name naheliegt: hat der Player den
    /// primaeren Kontext bereits geholt — und genau die Reihenfolge hat er —,
    /// scheitert `av_hwdevice_ctx_create` mit
    /// `Primary context already active with incompatible flags` (rc=-95,
    /// 16 von 16 Laeufen). Beleg fuer beides:
    /// `profiles/player-2026-08-07-cuvid-cuda-ausgabe.json`, Abschnitt
    /// `GEMESSEN_cuda_kontext`.
    ///
    /// `ffmpeg-sys-next` erzeugt fuer `hwcontext_cuda.h` keine Bindung, die
    /// Konstanten stehen deshalb als Zahl da statt als Symbol.
    fn flags(self, geteilter_kontext: bool) -> std::os::raw::c_int {
        match self {
            Self::Vaapi | Self::D3d11va => 0,
            Self::Cuda if geteilter_kontext => AV_CUDA_USE_CURRENT_CONTEXT,
            Self::Cuda => 0,
        }
    }

    /// In welchem Pixelformat der Decoder seine Bilder herausgibt, wenn dieses
    /// Geraet haengt. Das Bild liegt dann im Grafikspeicher und muss von
    /// [`VideoDecoder::drain`] heruntergeholt werden.
    ///
    /// Der `match` ist vollstaendig und ohne Auffangzweig — wer eine vierte
    /// Variante ergaenzt, kommt an dieser Stelle nicht vorbei.
    ///
    /// **Nur der Test ruft das auf, und das ist der Zweck.** [`drain`] kennt
    /// den Geraetetyp gar nicht mehr, wenn das Bild bei ihm ankommt — es sieht
    /// nur das Pixelformat und vergleicht gegen [`AUF_GPU_FORMATE`]. Beide
    /// Listen absichtlich getrennt zu fuehren und gegeneinander zu pruefen ist
    /// die einzige Art, das Auseinanderlaufen zu bemerken; leitete man eine aus
    /// der anderen ab, waere die Pruefung eine Tautologie.
    ///
    /// [`drain`]: VideoDecoder::drain
    #[cfg_attr(not(test), allow(dead_code))]
    fn bildformat(self) -> ffmpeg::format::Pixel {
        match self {
            Self::Vaapi => ffmpeg::format::Pixel::VAAPI,
            Self::D3d11va => ffmpeg::format::Pixel::D3D11,
            Self::Cuda => ffmpeg::format::Pixel::CUDA,
        }
    }
}

/// `AV_CUDA_USE_CURRENT_CONTEXT` aus `libavutil/hwcontext_cuda.h`.
///
/// **Als Zahl und nicht als Symbol**, weil `ffmpeg-sys-next` fuer
/// `hwcontext_cuda.h` keine Bindung erzeugt — dieselbe Luecke, die den Nachbau
/// von `AVCUDADeviceContext` erzwungen haette, wenn wir den Kontext von FFmpeg
/// holen wollten statt ihn ihm zu geben. Wer den Wert anzweifelt, sieht in
/// `hwcontext_cuda.h` nach, nicht hier.
const AV_CUDA_USE_CURRENT_CONTEXT: std::os::raw::c_int = 2;

/// Die Pixelformate, die [`VideoDecoder::drain`] aus dem Grafikspeicher
/// herunterholt.
///
/// **Warum das eine Konstante ist und keine Aufzaehlung im `matches!`.** Steht
/// ein Geraetetyp in der Kandidatenliste, sein Bildformat aber nicht hier,
/// liefert der Decoder sauber und [`convert`] lehnt jedes Bild ab: ein weisses
/// Fenster, ohne dass irgendwo ein Fehler steht, der nach der Ursache aussieht.
/// Genau so am 2026-08-04 mit D3D11 passiert und am 2026-08-07 fuer CUDA
/// vorhergesagt. Als Konstante laesst sich der Zusammenhang gegen
/// [`Hwaccel::bildformat`] pruefen, statt ihn zu hoffen.
const AUF_GPU_FORMATE: [ffmpeg::format::Pixel; 3] = [
    ffmpeg::format::Pixel::VAAPI,
    ffmpeg::format::Pixel::D3D11,
    ffmpeg::format::Pixel::CUDA,
];

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

    /// Ein cuvid-Decoder mit CUDA-Geraet, damit er auf der Karte herausgibt.
    ///
    /// Anders als [`nativ_hw`](Self::nativ_hw) aendert das nicht, WER
    /// dekodiert — cuvid laeuft ohnehin auf der GPU. Es aendert nur, wo das
    /// fertige Bild liegt.
    const fn cuda(name: &'static str) -> Self {
        Self {
            name,
            hw: Some(Hwaccel::Cuda),
        }
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

/// Wie viele Bilder hintereinander der Decoder liefern darf, die sich nicht
/// anzeigen lassen, bevor die Sitzung endet.
///
/// **Das ist die Luecke, in der KEIN Waechter mehr greift.** Der Decoder nimmt
/// jedes Paket an (`consecutive_errors` steht danach auf 0, also kann
/// [`neuaufbau::classify`] nie ausloesen), er liefert auch Bilder — nur kann
/// [`convert`] sie nicht uebersetzen, etwa `YUV444P` aus AV1 Profile 1 oder
/// H.264 High 4:4:4. Damit kommt beim Einfrier-Waechter nie ein Bild an,
/// `letzte_aenderung` bleibt `None` und [`crate::einfrieren`] schweigt
/// ebenfalls; Bytes fliessen weiter, also greift auch der Stille-Abbruch
/// nicht. Ohne diese Grenze steht das letzte Bild endlos.
///
/// 60 sind eine Sekunde bei 60 fps. Ein einzelner Fehlschlag, dem wieder
/// brauchbare Bilder folgen, ist nicht zu erwarten — welche vier Formate
/// tragen, entscheidet der Bitstrom und nicht der Zufall. Der Zaehler faellt
/// trotzdem bei jedem gelieferten Bild auf null zurueck, damit nur eine
/// wirklich durchgehende Serie zaehlt.
///
/// **Neu aufgebaut wird hier NICHT**, obwohl das der naheliegende Weg waere
/// (`neuaufbau::classify`): der Ersatz ist immer Software, und Software
/// dekodiert einen 4:4:4-Strom genauso nach `YUV444P`. Ein Neuaufbau kann das
/// Pixelformat des Stroms nicht aendern, er kostet nur weitere Sekunden
/// Standbild vor demselben Ende.
const MAX_UNBRAUCHBARE_BILDER: u32 = 60;

/// Ab wann „seit langem kein Vollbild" als rollende Auffrischung gilt.
///
/// Der uebliche Vollbild-Abstand liegt bei zwei Sekunden. Fuenf sind reichlich
/// darueber und lassen einem ausgefallenen oder verspaeteten Vollbild Luft,
/// bevor die Betriebsart umgedeutet wird.
const OHNE_VOLLBILD_SCHWELLE_MS: u64 = 5_000;

/// Was am Strom ueber die Sendeart abzulesen ist (s. [`VideoDecoder::sendeart`]).
///
/// `Copy`, weil es in `SessionStats` mitreist und die ganze Struktur dort
/// kopiert wird. Deshalb hier auch KEINE Zeichenkette: die entsteht erst beim
/// Ausgeben (`beschreibung`).
/// `SessionStats` wird serialisiert und mit `Debug` geloggt — beides muss
/// dieser Typ deshalb koennen. Die Zeiten reisen als Millisekunden mit, weil
/// `Duration` in JSON sonst als Struktur aus Sekunden und Nanosekunden
/// erschiene und niemand das lesen will.
#[derive(Clone, Copy, Default, Debug, serde::Serialize)]
pub struct Sendeart {
    pub vollbilder: u64,
    /// Abstand der letzten beiden Vollbilder in ms. `None` = es gab erst eins.
    pub abstand_ms: Option<u64>,
    /// Groesse des letzten Vollbilds in Byte.
    pub bytes: usize,
    /// Wie lange das letzte Vollbild her ist, in ms. `None` = noch keins.
    pub her_ms: Option<u64>,
}

impl Sendeart {
    /// Eine Zeile fuer das Log. Nennt Zahlen und haengt nur dann eine Deutung
    /// an, wenn sie eindeutig ist.
    pub fn beschreibung(&self) -> String {
        let Some(her_ms) = self.her_ms else {
            return "noch kein Vollbild gesehen".to_string();
        };
        let her_s = her_ms as f64 / 1000.0;
        let kb = self.bytes as f64 / 1024.0;
        if her_ms >= OHNE_VOLLBILD_SCHWELLE_MS {
            return format!(
                "{} Vollbilder, letztes vor {her_s:.0} s ({kb:.0} KB) — keine periodischen \
                 Vollbilder, also rollende Auffrischung",
                self.vollbilder
            );
        }
        match self.abstand_ms {
            Some(a) => format!(
                "{} Vollbilder, Abstand {:.1} s, zuletzt {kb:.0} KB — periodische Vollbilder",
                self.vollbilder,
                a as f64 / 1000.0
            ),
            None => format!("erstes Vollbild vor {her_s:.1} s ({kb:.0} KB)"),
        }
    }
}

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
///
/// **Warum `*_cuvid` zweimal dasteht.** Der erste Eintrag haengt ein
/// CUDA-Geraet an, der zweite ist derselbe Decoder ohne. Das ist kein
/// Versehen, sondern der Rueckfall: laesst sich das Geraet nicht anlegen (kein
/// NVIDIA-Treiber, `libcuda` fehlt, Karte belegt), waere cuvid sonst
/// uebersprungen — obwohl er ohne Geraet genau so laeuft wie bis zum
/// 2026-08-07. Ohne diesen zweiten Eintrag koennte ein Fehler im neuen Weg den
/// Player still auf den nativen hwaccel oder auf Software werfen.
fn candidates(codec: Codec, allow_hw: bool) -> Vec<Kandidat> {
    candidates_mit(codec, allow_hw, cuda_ausgabe_vorgabe())
}

/// Der eigentliche Aufbau der Liste, ohne die Umgebung zu befragen.
///
/// Getrennt, weil `PULSE_PLAYER_CUDA_AUSGABE` prozessglobal ist: ein Test, der
/// sie setzt, veraendert jeden gleichzeitig laufenden Test mit. Beide
/// Schalterstellungen sind so ohne Wettrennen pruefbar.
fn candidates_mit(codec: Codec, allow_hw: bool, cuda_aus: bool) -> Vec<Kandidat> {
    // Erst mit Geraet, dann ohne — der zweite Eintrag ist der Rueckfall (s.o.).
    // Steht der Schalter auf aus, bleibt allein der Weg von vor dem 2026-08-07.
    let cuvid = |name: &'static str| -> Vec<Kandidat> {
        if cuda_aus {
            vec![Kandidat::cuda(name), Kandidat::sw(name)]
        } else {
            vec![Kandidat::sw(name)]
        }
    };
    let (hw, sw): (Vec<Kandidat>, &[Kandidat]) = match codec {
        Codec::Av1 => {
            let mut hw = cuvid("av1_cuvid");
            hw.push(Kandidat::nativ_hw("av1"));
            hw.push(Kandidat::sw("av1_qsv"));
            (hw, &[Kandidat::sw("libdav1d"), Kandidat::sw("av1")])
        }
        Codec::H264 => {
            let mut hw = cuvid("h264_cuvid");
            hw.push(Kandidat::nativ_hw("h264"));
            hw.push(Kandidat::sw("h264_qsv"));
            (
                hw,
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
            )
        }
        Codec::Opus => (Vec::new(), &[Kandidat::sw("libopus"), Kandidat::sw("opus")]),
    };
    let mut out = Vec::new();
    if allow_hw {
        out.extend_from_slice(&hw);
    }
    out.extend_from_slice(sw);
    out
}

/// Sollen die cuvid-Decoder ihre Bilder auf der Karte herausgeben?
///
/// `PULSE_PLAYER_CUDA_AUSGABE=0` schaltet es ab und stellt damit den Weg von
/// vor dem 2026-08-07 her (cuvid ohne Geraet, Bild im Hauptspeicher).
/// `=1` schaltet es ein, auch dort, wo es nicht die Vorgabe ist.
///
/// **Die Vorgabe haengt an der Plattform, und das ist Absicht.** Gemessen ist
/// der Weg auf Linux/NVIDIA (RTX 5080), und er ist dort der Anfang der
/// Zero-Copy-Kette. Unter Windows nimmt der Player den D3D11VA-Weg; dass cuvid
/// mit CUDA-Geraet sich dort genauso verhaelt, ist plausibel und **ungemessen**
/// — eine ungemessene Verhaltensaenderung auf einer Plattform, die niemand hier
/// nachstellt, gehoert nicht in die Vorgabe. Der Schalter macht sie trotzdem
/// pruefbar.
///
/// Kostet der eingeschaltete Weg fuer sich genommen nichts und bringt nichts:
/// [`VideoDecoder::drain`] holt das Bild weiterhin herunter, nur sichtbar statt
/// unsichtbar. Er ist die Vorbereitung, nicht der Gewinn (s. Modulkopf).
fn cuda_ausgabe_vorgabe() -> bool {
    match std::env::var("PULSE_PLAYER_CUDA_AUSGABE").as_deref() {
        Ok("0") => false,
        Ok("1") => true,
        _ => cfg!(target_os = "linux"),
    }
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
fn hw_geraet_anhaengen(
    ctx: *mut ffmpeg::ffi::AVCodecContext,
    art: Hwaccel,
    geraet_fuer_bruecke: &Option<wgpu::Device>,
) -> Result<()> {
    // **Der geteilte CUDA-Kontext muss VOR `av_hwdevice_ctx_create` stehen**,
    // sonst gibt es keinen „current context", den FFmpeg uebernehmen koennte.
    // Schlaegt es fehl, laeuft die Dekodierung trotzdem — nur eben mit FFmpegs
    // eigenem Kontext und damit ohne Zero-Copy (s. `Hwaccel::flags`).
    let geteilt =
        art == Hwaccel::Cuda && crate::zerocopy::kontext_bereitstellen(geraet_fuer_bruecke);
    // Nur VAAPI braucht einen Pfad. D3D11VA und CUDA waehlen ohne Angabe den
    // Standard-Adapter bzw. Geraet 0 — auf einer Maschine mit zwei GPUs also
    // dasselbe, das auch der Rest des Systems benutzt. Bei uebernommenem
    // Kontext ist die Karte ohnehin schon entschieden.
    let pfad = match art {
        Hwaccel::Vaapi => Some(vaapi_geraetepfad()),
        Hwaccel::D3d11va | Hwaccel::Cuda => None,
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
            art.flags(geteilt),
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

    fn give_back(&self, buffers: Vec<Vec<u8>>) {
        let Ok(mut pool) = self.0.lock() else { return };
        for mut buf in buffers {
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
    /// Was der Strom ueber seine Farben sagt — YUV-Matrix, Transferkurve,
    /// Farbraum und Spitzenhelligkeit.
    ///
    /// **Die Matrix stand hier bis zum 2026-08-06 zusaetzlich als eigenes
    /// Feld.** Beim Ergaenzen der HDR-Angaben waeren daraus zwei Fassungen
    /// derselben Auskunft geworden, die beim naechsten Umbau auseinanderlaufen
    /// — und eine falsche Matrix sieht man dem Bild nicht an, es wirkt nur
    /// flau. Deshalb nur noch hier.
    pub farbe: Farbangaben,
    /// Wann das Paket eintraf, das die Zugriffseinheit dieses Bildes
    /// abschloss. Traegt die Latenzmessung bis zum gezeichneten Bild; `None`,
    /// wenn das Bild nicht aus einem Netzpaket stammt (Tests).
    pub arrived: Option<std::time::Instant>,
    /// RTP-Zeitstempel der Zugriffseinheit und ihr Takt (fast immer 90 kHz).
    ///
    /// **Der Unterschied zu [`arrived`](Self::arrived) ist der ganze Zweck.**
    /// `arrived` sagt, wann das Bild HIER ankam — das enthaelt jede Schwankung
    /// der Leitung. Der RTP-Zeitstempel sagt, wann es beim Sender ENTSTAND, und
    /// zwar auf dessen gleichmaessiger Uhr. Nur damit laesst sich die Ausgabe
    /// gleichmaessig takten, statt sie an die Ankunft zu haengen (s.
    /// `app::takt`).
    ///
    /// `None`, wenn das Bild nicht aus einem Netzpaket stammt (Tests) — dann
    /// gibt es nichts zu takten und die Anzeige laeuft wie bisher sofort.
    ///
    /// **Mehrere Bilder aus EINER Zugriffseinheit teilen sich den Wert.** Bei
    /// den hier gefahrenen Codecs kommt das nicht vor (eine Einheit ist ein
    /// Bild); traefe es zu, laegen sie auf demselben Zielzeitpunkt und wuerden
    /// bis auf das letzte verworfen — dasselbe, was heute schon passiert.
    pub rtp_ts: Option<u32>,
    pub clock_rate: u32,
    /// Das Bild liegt im Grafikspeicher (s. [`crate::zerocopy`]).
    ///
    /// **Ist das gesetzt, sind `planes` und `strides` leer.**
    ///
    /// **Hier stand bis zum 2026-08-06 „und damit fallen der Einfrier-Waechter
    /// und die Latenz-Sonde aus, weil beide die Ebenen im Hauptspeicher lesen.
    /// Genau deshalb ist der Weg ausdruecklich anzufordern und nicht die
    /// Vorgabe." Fuer den Waechter ist das falsch** — sein Fingerabdruck
    /// entsteht auf diesem Weg im Renderer, auf der GPU
    /// (`render::abdruck`), und kommt ueber [`crate::einfrieren::Briefkasten`]
    /// zurueck. Der Weg ist seither die Vorgabe.
    ///
    /// Was bleibt: die Latenz-Sonde misst hier nicht (sie sagt es, s.
    /// [`crate::probe`]). Der RTP-Mitschnitt `PULSE_PLAYER_DUMP_RTP` war nie
    /// betroffen — er sitzt vor dem Decoder.
    pub gpu: Option<std::sync::Arc<crate::zerocopy::GpuBild>>,
    /// Wohin die Ebenen-Puffer zurueckgehen (s. [`PlanePool`]).
    pub(crate) pool: PlanePool,
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
            farbe: Farbangaben::default(),
            arrived: None,
            rtp_ts: None,
            clock_rate: 0,
            gpu: None,
            pool: PlanePool::default(),
        }
    }
}

impl Drop for DecodedFrame {
    fn drop(&mut self) {
        // Nichts zurueckzugeben heisst: gar nicht erst sperren. Auf dem
        // Zero-Copy-Weg sind die Ebenen immer leer, und `give_back` nimmt sonst
        // je Bild eine Sperre, um dann nichts zu tun.
        if self.planes.is_empty() {
            return;
        }
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
    /// BT.2020 ohne konstante Leuchtdichte — die Matrix jedes HDR10-Stroms.
    ///
    /// **Eigene Zeile, obwohl die Koeffizienten denen von BT.709 aehneln.** Sie
    /// tun es nur ungefaehr (1,4746 gegen 1,5748 fuer Rot), und der Unterschied
    /// faellt genau dort auf, wo man ihn am wenigsten sucht: das Bild bleibt
    /// vollstaendig plausibel, nur Hauttoene und gesaettigtes Gruen wandern.
    /// Denselben Fehler hat der Player schon einmal gemacht, als er BT.601 als
    /// BT.709 gelesen hat (2026-07-26).
    Bt2020Ncl,
}

/// Wie die Codewerte des Stroms in Licht uebersetzt werden.
///
/// Der Unterschied ist nicht graduell: eine SDR-Kurve ist RELATIV (1,0 heisst
/// „so hell der Schirm eben ist"), PQ ist ABSOLUT (1,0 heisst 10 000 cd/m²).
/// Einen PQ-Strom wie SDR zu zeichnen ergibt ein Bild, das durchweg viel zu
/// dunkel und entsaettigt ist — der haeufigste sichtbare HDR-Fehler ueberhaupt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Uebertragung {
    /// Alles, was keine PQ-Kurve ist — die uebliche Gamma-artige Kodierung.
    Sdr,
    /// SMPTE ST 2084 (PQ), die Kurve von HDR10.
    Pq,
}

/// Was der Strom ueber Farbraum und Helligkeit sagt — alles, was der Shader
/// braucht und was NICHT an der Form der Bildpunkte haengt.
///
/// Als eigener Typ statt dreier Felder in [`DecodedFrame`], weil die drei
/// Angaben nur zusammen einen Sinn ergeben: PQ ohne BT.2020-Primaervalenzen
/// gibt es in der Praxis nicht, und eine Spitzenhelligkeit ohne PQ ist
/// bedeutungslos.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Farbangaben {
    pub matrix: ColorMatrix,
    pub uebertragung: Uebertragung,
    /// Liegen die Primaervalenzen in BT.2020 statt BT.709? Getrennt von der
    /// Kurve, weil beides unabhaengig voneinander falsch sein kann — es gibt
    /// SDR-Stroeme in BT.2020, und ein PQ-Strom ohne Primaervalenzen-Angabe
    /// waere zwar unueblich, aber nicht unmoeglich.
    pub weiter_farbraum: bool,
    /// Spitzenhelligkeit des Inhalts in cd/m², aus den Metadaten des Stroms.
    ///
    /// Gebraucht wird sie nur beim Herunterrechnen auf einen SDR-Schirm: sie
    /// sagt, wo die Kurve enden muss. `None` heisst „der Strom sagt nichts" —
    /// dann nimmt der Player einen Ersatzwert und sagt das auch (s.
    /// `render::farbe`). Eine geratene Zahl als gemessene auszugeben waere hier
    /// besonders teuer, weil man dem Ergebnis nicht ansieht, dass sie geraten
    /// war.
    pub spitze_nits: Option<f32>,
}

impl Default for Farbangaben {
    fn default() -> Self {
        Self {
            matrix: ColorMatrix::Bt709,
            uebertragung: Uebertragung::Sdr,
            weiter_farbraum: false,
            spitze_nits: None,
        }
    }
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
        // Beide BT.2020-Fassungen landen hier. Der Player rechnet die
        // NCL-Matrix; die CL-Fassung („constant luminance") kommt in der Praxis
        // nicht vor — kein Encoder erzeugt sie —, und sie hier als NCL zu
        // behandeln ist der weit kleinere Fehler, als sie auf BT.709
        // zurueckfallen zu lassen.
        Space::BT2020NCL | Space::BT2020CL => ColorMatrix::Bt2020Ncl,
        _ => {
            if height <= 576 {
                ColorMatrix::Bt601
            } else {
                ColorMatrix::Bt709
            }
        }
    }
}

/// Die Farbangaben eines dekodierten Bildes zusammentragen.
///
/// **Alles kommt aus dem Strom, nichts wird aus der Aufloesung geraten** —
/// ausser der Matrix, die ihre eigene, alte Regel hat ([`matrix_of`]).
///
/// `PULSE_PLAYER_TRANSFER=sdr|pq` nagelt die Kurve fest, Gegenstueck zu
/// `PULSE_PLAYER_MATRIX` und `PULSE_PLAYER_SURFACE`: nur so laesst sich
/// „das Bild ist zu dunkel" auf eine der drei Ursachen eingrenzen, ohne den
/// Player neu zu bauen.
fn farbangaben_von(frame: &ffmpeg::util::frame::video::Video, height: u32) -> Farbangaben {
    use ffmpeg::color::{Primaries, TransferCharacteristic};
    let uebertragung = match std::env::var("PULSE_PLAYER_TRANSFER").as_deref().map(str::trim) {
        Ok("sdr") => Uebertragung::Sdr,
        Ok("pq") => Uebertragung::Pq,
        _ => match frame.color_transfer_characteristic() {
            TransferCharacteristic::SMPTE2084 => Uebertragung::Pq,
            // **HLG faellt bewusst auf SDR zurueck und nicht auf PQ.** Die
            // Kurve ist eine andere, und HLG als PQ zu lesen ergibt ein
            // groteskes Bild. Als SDR gelesen ist es nur etwas flau — HLG ist
            // rueckwaertskompatibel gebaut, genau dafuer. Wir erzeugen kein HLG;
            // sollte es je hier ankommen, ist der milde Fehler der richtige.
            _ => Uebertragung::Sdr,
        },
    };
    Farbangaben {
        matrix: matrix_of(frame.color_space(), height),
        uebertragung,
        weiter_farbraum: matches!(frame.color_primaries(), Primaries::BT2020),
        spitze_nits: spitze_nits_von(frame),
    }
}

/// Die Spitzenhelligkeit des Inhalts aus den Begleitdaten des Bildes.
///
/// Zwei Quellen, in dieser Reihenfolge — und die Reihenfolge ist die Aussage:
///
/// 1. **Content-Light-Level (`MaxCLL`)** beschreibt, was im INHALT wirklich
///    vorkommt. Das ist die Zahl, die das Herunterrechnen braucht.
/// 2. **Mastering-Display** beschreibt das GERAET, auf dem gemastert wurde —
///    eine obere Schranke, oft deutlich zu hoch. Nur als Ersatz.
///
/// `None`, wenn der Strom nichts sagt. Der Aufrufer setzt dann einen
/// Ersatzwert und meldet das (`render::farbe`), statt eine geratene Zahl wie
/// eine gemessene zu behandeln.
///
/// Der Zugriff laeuft ueber `av_frame_get_side_data`, weil `ffmpeg-next` fuer
/// diese beiden Nutzlasten keine sicheren Typen hat — dieselbe Lage wie im
/// Sidecar (`encode/hdr.rs`), nur andersherum: dort schreiben wir sie, hier
/// lesen wir sie.
fn spitze_nits_von(frame: &ffmpeg::util::frame::video::Video) -> Option<f32> {
    use ffmpeg::ffi::{AVFrameSideDataType, av_frame_get_side_data};

    /// `AVContentLightMetadata` — zwei `unsigned` in cd/m².
    #[repr(C)]
    struct ContentLight {
        max_cll: std::os::raw::c_uint,
        max_fall: std::os::raw::c_uint,
    }
    /// `AVMasteringDisplayMetadata`; uns interessiert nur `max_luminance`, der
    /// Rest steht fuer das richtige Speicherlayout da.
    #[repr(C)]
    struct Mastering {
        display_primaries: [[ffmpeg::ffi::AVRational; 2]; 3],
        white_point: [ffmpeg::ffi::AVRational; 2],
        min_luminance: ffmpeg::ffi::AVRational,
        max_luminance: ffmpeg::ffi::AVRational,
        has_primaries: std::os::raw::c_int,
        has_luminance: std::os::raw::c_int,
    }

    unsafe {
        let ptr = frame.as_ptr();
        let cll = av_frame_get_side_data(ptr, AVFrameSideDataType::AV_FRAME_DATA_CONTENT_LIGHT_LEVEL);
        if !cll.is_null() {
            let m = &*((*cll).data as *const ContentLight);
            if m.max_cll > 0 {
                return Some(m.max_cll as f32);
            }
        }
        let md = av_frame_get_side_data(
            ptr,
            AVFrameSideDataType::AV_FRAME_DATA_MASTERING_DISPLAY_METADATA,
        );
        if !md.is_null() {
            let m = &*((*md).data as *const Mastering);
            if m.has_luminance != 0 && m.max_luminance.den != 0 {
                let nits = m.max_luminance.num as f32 / m.max_luminance.den as f32;
                if nits > 0.0 {
                    return Some(nits);
                }
            }
        }
    }
    None
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
    /// Neuaufbauten, die aktuell gegen den Decoder zaehlen — samt Bewaehrung
    /// (s. [`crate::neuaufbau`]; dort stehen auch die Tests, die frueher hier
    /// neben `classify` lagen).
    rebuilds: Neuaufbauten,
    /// Solange gesetzt, wird jede Einheit verworfen, die kein Einstiegspunkt
    /// ist. Siehe [`VideoDecoder::decode`].
    awaiting_keyframe: bool,
    /// Wie viele Einheiten dabei bisher verworfen wurden.
    skipped_before_keyframe: u64,
    /// Bis wann das Bild nach einer Luecke als unsauber gilt (s. [`on_gap`]).
    unsauber_bis: Option<std::time::Instant>,
    /// Der Einfrier-Nachweis samt Staffelung der Abhilfe (s.
    /// [`crate::einfrieren`]).
    wacht: EinfrierWacht,
    /// Wie viele Vollbilder bisher ankamen, und wann das letzte kam —
    /// gemeldet, weil der Abstand verraet, ob sich zwei Keyframe-Quellen
    /// ueberlagern (Sender-Takt plus Server-Uhr).
    keyframes: u64,
    letztes_keyframe: Option<std::time::Instant>,
    /// Abstand der letzten beiden Vollbilder und Groesse des letzten. Zusammen
    /// mit `letztes_keyframe` ist das die Antwort auf „was schickt der Sender
    /// eigentlich" — s. [`VideoDecoder::sendeart`].
    keyframe_abstand: Option<std::time::Duration>,
    keyframe_bytes: usize,
    /// Vorrat fuer die Ebenen-Puffer (s. [`PlanePool`]). Ueberlebt den
    /// Neuaufbau des Decoders, weil die Puffergroessen dieselben bleiben.
    plane_pool: PlanePool,
    /// Wiederverwendetes Ziel fuer den Weg von der GPU in den Hauptspeicher
    /// (s. [`in_den_hauptspeicher`]). Benutzt, wann immer das Bild im
    /// Grafikspeicher liegt und die Bruecke es nicht uebernommen hat — also bei
    /// VAAPI, D3D11VA und CUDA (s. [`AUF_GPU_FORMATE`]).
    ///
    /// **Hier stand „Nur auf dem VAAPI-Weg benutzt" — das ist seit dem
    /// 2026-08-04 falsch**, seit `drain` denselben Weg auch fuer
    /// `Pixel::D3D11` nimmt, und seit dem 2026-08-07 auch fuer `Pixel::CUDA`.
    hw_ziel: ffmpeg::util::frame::video::Video,
    /// Wie lange das Ruecklesen aus dem Grafikspeicher im laufenden Durchgang
    /// gedauert hat. Wird je `decode` zurueckgesetzt und dort ausgewertet
    /// (s. [`crate::stockung`]).
    ruecklesen_us: u64,
    /// Dasselbe fuer den Weg am Hauptspeicher vorbei (s. [`crate::zerocopy`]).
    bruecke_us: u64,
    /// Zaehlt haengende Ruecklesevorgaenge (s. [`crate::stockung::Waechter`]).
    stockungen: crate::stockung::Waechter,
    /// Bilder in Folge, die der Decoder geliefert hat und [`convert`] nicht
    /// uebersetzen konnte (s. [`MAX_UNBRAUCHBARE_BILDER`]).
    unbrauchbare_bilder: u32,
    /// Der Weg am Hauptspeicher vorbei. Die drei Zustaende dieses `Option` sind
    /// in [`crate::zerocopy::bild_ohne_umweg`] erklaert, wo sie ausgewertet
    /// werden.
    bruecke: Option<Option<crate::zerocopy::Bruecke>>,
    /// Der Rueckweg der auf der GPU gerechneten Fingerabdruecke (s.
    /// [`crate::einfrieren::Zulauf`]). Nur auf dem Zero-Copy-Weg in Gebrauch.
    zulauf: crate::einfrieren::Zulauf,
    /// Das wgpu-Geraet des Fensters, in dem dieser Strom laeuft.
    ///
    /// **Nur die LINUX-Bruecke braucht es**, und sie braucht es zwingend: ein
    /// `VkImage` gehoert unaufloesbar zu seinem `VkDevice`, das Zielbild muss
    /// also auf genau dem Geraet entstehen, das der Renderer dieses Fensters
    /// fuehrt. Ein prozessweites Geraet waere falsch — der Player fuehrt
    /// mehrere Fenster mit je eigenem Geraet (`app::Session`).
    ///
    /// `None` heisst „kein Fenster dahinter": dann bleibt es beim Weg ueber den
    /// Hauptspeicher. Die Windows-Bruecke laesst es ungenutzt (NT-Handles
    /// lassen sich auf jedem D3D12-Geraet oeffnen).
    geraet: Option<wgpu::Device>,
}

impl VideoDecoder {
    /// Legt einen Decoder an. `allow_hw = None` bedeutet automatisch.
    ///
    /// `geraet` ist das wgpu-Geraet des zugehoerigen Fensters (s. dem Feld
    /// gleichen Namens); ohne es laeuft alles wie bisher, nur ohne die
    /// Linux-Bruecke.
    pub fn new(
        codec: Codec,
        allow_hw: Option<bool>,
        geraet: Option<wgpu::Device>,
    ) -> Result<Self> {
        ffmpeg::init().context("FFmpeg-Initialisierung")?;
        if !codec.is_video() {
            bail!("{} ist kein Video-Codec", codec.as_str());
        }
        let allow = allow_hw.unwrap_or_else(hwdec_vorgabe);

        let mut last_err = None;
        for kandidat in candidates(codec, allow) {
            match Self::try_open(kandidat, &geraet) {
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
                        rebuilds: Neuaufbauten::default(),
                        awaiting_keyframe: true,
                        skipped_before_keyframe: 0,
                        unsauber_bis: None,
                        wacht: EinfrierWacht::default(),
                        keyframes: 0,
                        letztes_keyframe: None,
                        keyframe_abstand: None,
                        keyframe_bytes: 0,
                        plane_pool: PlanePool::default(),
                        hw_ziel: ffmpeg::util::frame::video::Video::empty(),
                        ruecklesen_us: 0,
                        bruecke_us: 0,
                        stockungen: crate::stockung::Waechter::default(),
                        unbrauchbare_bilder: 0,
                        bruecke: None,
                        zulauf: crate::einfrieren::Zulauf::default(),
                        geraet,
                    });
                }
                Err(e) => {
                    // **Jeder uebersprungene Kandidat wird genannt.** Bis zum
                    // 2026-08-07 stand hier nur `last_err = Some(e)`: die
                    // Gruende wurden verworfen, und ueberlebt hat allein der
                    // Fehler des LETZTEN Kandidaten — der wiederum nur zu sehen
                    // war, wenn gar keiner aufging. Ein Rueckfall von
                    // `av1_cuvid` auf `libdav1d` sah im Log deshalb aus wie
                    // eine gewoehnliche Wahl, und die Frage „warum eigentlich
                    // Software?" war aus dem Protokoll heraus nicht zu
                    // beantworten (am 2026-08-07 genau so aufgeschlagen).
                    //
                    // Es ist eine Zeile je Kandidat und nur beim Anlegen des
                    // Decoders, nicht je Bild.
                    eprintln!(
                        "pulse-player: Decoder {} ({}) nicht verwendbar: {e:#}",
                        kandidat.name,
                        kandidat.beschreibung()
                    );
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.unwrap_or_else(|| anyhow!("kein Decoder fuer {}", codec.as_str())))
    }

    /// Probiert alle Kandidaten durch und berichtet, was mit jedem passiert —
    /// **ohne Fenster, ohne Netz, ohne Strom**.
    ///
    /// Dafuer gebaut, dass sich die Frage „warum dekodiert die Maschine in
    /// Software?" auf der betroffenen Maschine beantworten laesst, statt sie
    /// aus einem Fehlerbild zu erraten. Im Flatpak ist das der einzige
    /// gangbare Weg: dort gibt es kein `ffmpeg`-Programm, mit dem man dasselbe
    /// von Hand nachstellen koennte (`--disable-programs`), und die
    /// gebuendelte Bibliothek ist eine andere als die des Systems.
    ///
    /// Es wird nur geOEFFNET und sofort wieder verworfen; dekodiert wird
    /// nichts. Das genuegt, weil genau das Oeffnen die Stelle ist, an der ein
    /// Kandidat ausfaellt.
    ///
    /// **Eine Grenze der Aussage:** ohne Fenster gibt es kein wgpu-Geraet,
    /// der CUDA-Kandidat wird also ohne den geteilten Kontext geprueft. Sagt
    /// die Sonde bei ihm „geht", ist damit belegt, dass Treiber und Decoder
    /// da sind — nicht, dass die Bruecke im Betrieb aufgeht. Sagt sie
    /// „geht nicht", ist der Ausfall echt und liegt vor der Bruecke.
    pub fn sonde(codec: Codec) -> Vec<(&'static str, &'static str, Option<String>)> {
        let _ = ffmpeg::init();
        candidates(codec, hwdec_vorgabe())
            .into_iter()
            .map(|k| {
                let fehler = Self::try_open(k, &None).err().map(|e| format!("{e:#}"));
                (k.name, k.beschreibung(), fehler)
            })
            .collect()
    }

    fn try_open(
        kandidat: Kandidat,
        geraet: &Option<wgpu::Device>,
    ) -> Result<ffmpeg::decoder::Video> {
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
            hw_geraet_anhaengen(ptr, art, geraet)
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
            self.keyframe_abstand = self.letztes_keyframe.map(|t| jetzt.duration_since(t));
            self.keyframe_bytes = data.len();
            let abstand = self
                .keyframe_abstand
                .map(|d| format!("{:.0} ms", d.as_millis()))
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

        // Zaehlt mit, wieviel seit dem letzten VERAENDERTEN Bild hineingegangen
        // ist — der Boden des Einfrier-Nachweises (s. [`crate::einfrieren`]).
        self.wacht.daten(data.len());

        // Ab hier laeuft die Uhr fuer den Stockungs-Nachweis: die Statistik
        // meldet nur, DASS ein Durchgang zwei Sekunden gedauert hat, nicht
        // worin (s. `crate::stockung`).
        let uhr = std::time::Instant::now();
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
            match neuaufbau::classify(self.consecutive_errors, self.rebuilds.anzahl()) {
                ErrorAction::Ignore => {}
                ErrorAction::Rebuild => self.rebuild(&e.to_string(), uhr)?,
                ErrorAction::GiveUp => bail!(
                    "Decoder {} nimmt seit {} Einheiten keine Pakete mehr an ({e})",
                    self.name,
                    self.consecutive_errors
                ),
            }
            return Ok(Vec::new());
        }
        self.consecutive_errors = 0;
        // Ein angenommenes Paket traegt die Bewaehrung eines Neuaufbaus ab —
        // ohne das zaehlte jede Fehlerserie einer langen Sitzung gegen die
        // naechste, und die dritte beendete sie (s. `crate::neuaufbau`).
        self.rebuilds.erfolg(uhr);
        let hineingeben = uhr.elapsed().as_micros() as u64;
        self.ruecklesen_us = 0;
        self.bruecke_us = 0;
        let bilder = self.drain();
        let abschnitte = crate::stockung::Abschnitte {
            hineingeben,
            herausholen: uhr.elapsed().as_micros() as u64 - hineingeben,
            ruecklesen: self.ruecklesen_us,
            bruecke: self.bruecke_us,
        };
        crate::stockung::melden(abschnitte, bilder.len());
        // Haengt die Grafikeinheit wiederholt, ist der Hardware-Weg aufzugeben.
        // Das Bild wird dadurch teurer, aber es kommt wieder — vorher fiel die
        // ganze Sitzung auseinander (s. [`crate::stockung::Waechter`]).
        if self.hardware
            && crate::stockung::rueckfall_erlaubt()
            && crate::stockung::ist_grafikstockung(abschnitte)
            && self.stockungen.stockung(std::time::Instant::now())
        {
            self.auf_software("das Warten auf die Grafikeinheit blockiert wiederholt")?;
        }
        // Der Decoder nimmt an und liefert, nur ist nichts davon anzeigbar.
        // Kein Waechter faengt das ab (s. [`MAX_UNBRAUCHBARE_BILDER`]) — ohne
        // diesen Abbruch stuende das letzte Bild bis zum Sitzungsende.
        if self.unbrauchbare_bilder >= MAX_UNBRAUCHBARE_BILDER {
            bail!(
                "Decoder {} liefert seit {} Bildern nur Formate, die nicht \
                 angezeigt werden koennen",
                self.name,
                self.unbrauchbare_bilder
            );
        }
        Ok(bilder)
    }

    /// Auf Software umstellen, weil der Hardware-Weg zwar liefert, aber zu
    /// spaet (s. [`crate::stockung`]).
    ///
    /// **Zaehlt bewusst NICHT gegen [`neuaufbau::MAX_REBUILDS`].** Der Zaehler steht fuer
    /// „dieser Decoder ist kaputt, und der Ersatz ist es womoeglich auch";
    /// nach zwei Versuchen gibt er die Sitzung auf. Hier ist aber nichts
    /// kaputt: die Umstellung ist eine einmalige, absichtliche
    /// Strategieaenderung, und sie kann sich nicht wiederholen (danach ist
    /// `hardware` falsch). Am 2026-08-06 im ersten Lauf mit dem Rueckfall
    /// beobachtet: die Umstellung verbrauchte Versuch 1 von 2, der ohnehin
    /// folgende Anlauffehler des frischen Decoders Versuch 2 — und die
    /// naechste Fehlerserie haette die Sitzung beendet. Genau das, was der
    /// Rueckfall verhindern soll.
    fn auf_software(&mut self, grund: &str) -> Result<()> {
        eprintln!("pulse-player: Decoder {} wird aufgegeben: {grund} — weiter in Software", self.name);
        self.frischer_software_decoder()
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
    ///
    /// `jetzt` wird durchgereicht statt hier neu geholt: Zaehlen und Bewaehren
    /// muessen auf DERSELBEN Uhr rechnen, sonst haengt die Bewaehrungsfrist an
    /// der Laufzeit eines Aufrufs.
    fn rebuild(&mut self, cause: &str, jetzt: std::time::Instant) -> Result<()> {
        let nummer = self.rebuilds.gezaehlt(jetzt);
        // **Hier stand bis zum 2026-08-06 „lehnt dauerhaft ab" fest im Text.**
        // Das stimmt nur fuer den einen Anlass, aus dem es die Funktion gab
        // (abgelehnte Pakete); seit der zweite dazukam — eine haengende
        // Grafikeinheit, bei der jedes Paket ANGENOMMEN wird — waere die Zeile
        // schlicht falsch gewesen und haette die Suche in die Irre geschickt.
        eprintln!(
            "pulse-player: Decoder {} wird aufgegeben: {cause} — \
             Neuaufbau {nummer}/{} als Software",
            self.name,
            neuaufbau::MAX_REBUILDS
        );
        self.frischer_software_decoder()
    }

    /// Den laufenden Decoder gegen einen frischen Software-Decoder tauschen.
    ///
    /// Der gemeinsame Rumpf von [`Self::rebuild`] (Fehlerserie) und
    /// [`Self::auf_software`] (haengende Grafikeinheit) — bis auf den Zaehler
    /// und die Meldung ist der Vorgang derselbe.
    fn frischer_software_decoder(&mut self) -> Result<()> {
        let fresh = Self::new(self.codec, Some(false), self.geraet.clone())?;
        self.decoder = fresh.decoder;
        self.name = fresh.name;
        self.hardware = fresh.hardware;
        self.consecutive_errors = 0;
        // Der Ersatz liefert andere Pixelformate als der abgeloeste Decoder —
        // was er vorher nicht uebersetzen konnte, zaehlt nicht gegen ihn.
        self.unbrauchbare_bilder = 0;
        // Ein frischer Decoder hat weder Sequence-Header noch Referenzbild —
        // er braucht denselben Einstiegspunkt wie beim Sitzungsbeginn.
        self.awaiting_keyframe = true;
        self.skipped_before_keyframe = 0;
        // Der Ersatz ist IMMER Software, liefert also `YUV420P`/`YUV420P10LE`
        // — und fuer die ist `crate::zerocopy::bruecke_moeglich` falsch (sie
        // kennt nur `D3D11` und `CUDA`). Beide Halden des Hardware-Wegs werden
        // hier also nie wieder angefasst: `hw_ziel` ein volles Bild (1,4 MB bei
        // 720p NV12, ein Vielfaches bei 1440p10) und der Windows-Ring bis zu
        // `RING_SPEICHER_MAX` (320 MB). Ausgerechnet in dem Moment, in dem die
        // Grafikeinheit ohnehin in Not war — das war ja der Anlass des
        // Rueckfalls.
        //
        // **Freigegeben wird trotzdem nur `hw_ziel`.** Hier stand am 2026-08-08
        // kurzzeitig auch `self.bruecke = Some(None)`, um den Ring mitzunehmen.
        // Das ist FALSCH und wurde in derselben Sitzung von der Gegenprobe
        // gefangen: `Some(None)` laesst die `Bruecke` sofort fallen, und deren
        // `Drop` macht `CloseHandle` auf JEDEN Ringplatz (`zerocopy/bruecke.rs`).
        // Ein ausgeliefertes `GpuBild` haelt unter Windows aber nur den
        // Zahlenwert `handle: isize` (`zerocopy/platz.rs`) — anders als unter
        // Linux, wo es ein `Arc<Ringplatz>` fuehrt. Die Invariante steht als
        // Zusicherung an `GpuBild::handle()`: „Bleibt ueber die ganze
        // Lebensdauer der Bruecke gueltig."
        //
        // Und der Aufrufer verletzt sie sofort: `neuaufbau_wenn_noetig` sammelt
        // die Bilder mit `self.drain()` ein, BEVOR es `auf_software` ruft, und
        // gibt sie danach zurueck. Dazu die schon abgeschickten im Kanal zum
        // Fenster-Faden (32) und in der Takt-Warteschlange (12). Jedes davon
        // laeuft im Renderer in `Fremdbilder::binden`; war sein Platz noch nicht
        // gezeichnet, folgt `OpenSharedHandle` auf ein geschlossenes Handle.
        //
        // Das ist Befund 4 aus demselben Bughunt, mit einem neuen Ausloeser.
        // Der Ring darf hier erst mitgehen, wenn Befund 4 behoben ist, also
        // wenn `Ringplatz` wie unter Linux in einem `Arc` steckt, das jedes
        // `GpuBild` mithaelt. Bis dahin ist ein belegter Ring das kleinere
        // Uebel: 320 MB kosten Speicher, ein geschlossenes Handle kostet den
        // Prozess.
        self.hw_ziel = ffmpeg::util::frame::video::Video::empty();
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
    /// ueber **zweieinhalb Sekunden** lang jedes Bild denselben Fingerabdruck
    /// traegt, waehrend ordentlich Daten hineingehen, rechnet der Decoder nicht
    /// mehr.
    ///
    /// **Hier stand bis zum 2026-08-06 „ueber eine Sekunde lang"**, und die
    /// Schwelle war in Bildern gefasst (90). Beides war zu kurz: der Sender
    /// legt alle zwei Sekunden ein Vollbild bzw. einen abgeschlossenen
    /// Auffrischungsdurchlauf hin, und dabei aendert sich das dekodierte Bild
    /// auch bei stehendem Inhalt. Ein Fenster darunter sieht dort ein
    /// Standbild, das keines ist — und in Bildern gefasst war es bei 144 fps
    /// noch einmal um mehr als das Doppelte zu kurz. Messreihe:
    /// [`crate::einfrieren`].
    ///
    /// **Hier stand bis zum 2026-08-05 „Ein echtes Standbild sieht anders aus —
    /// dort schickt der Encoder winzige Bilder, weil sich nichts aendert;
    /// deshalb die Byte-Schwelle." Das ist falsch**: die Schwelle zaehlt Bytes,
    /// ohne hineinzusehen, und ein Encoder mit Fuellmaterial haelt seine Rate
    /// auch bei Standbild. Die Schwelle bleibt als Boden („kommt ueberhaupt
    /// etwas an"), unterscheidet aber nichts — deshalb ist die Abhilfe
    /// gestaffelt. Volle Begruendung samt Messreihe: [`crate::einfrieren`].
    pub fn eingefroren(&mut self) -> bool {
        self.wacht.eingefroren()
    }

    /// Setzt den Decoder nach einem erkannten Einfrieren neu auf.
    ///
    /// Wie der Keyframe-Zweig von [`on_gap`]: leeren und auf den naechsten
    /// Einstiegspunkt warten. Ohne das Leeren rechnet er auf demselben kaputten
    /// Zustand weiter, den wir gerade festgestellt haben.
    pub fn wegen_einfrieren_neu(&mut self) {
        // Die Staffel gehoert in die Meldung: sie ist das Einzige, woran im
        // Log zu sehen ist, ob hier ein Decoder gerettet wird oder ob ein
        // Standbild immer wieder dieselbe Diagnose ausloest.
        // Beide Schwellen gehoeren in die Zeile, nicht nur die in Bildern:
        // welche von beiden bindet, haengt an der Ausgaberate, und wer im Log
        // nur „nach 90 Bildern" liest, rechnet bei 144 fps mit 0,6 Sekunden,
        // wo in Wahrheit 2,5 gelten (s. `einfrieren::EINFRIER_DAUER`).
        eprintln!(
            "pulse-player: Decoder eingefroren (gleiches Bild trotz Daten) — \
             leere ihn und fordere ein Vollbild an (Meldung {} ohne \
             zwischenzeitliche Bewegung, naechste Pruefung nach {} Bildern \
             UND {} ms)",
            self.wacht.stufe(),
            self.wacht.schwelle(),
            self.wacht.mindestdauer().as_millis()
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
    /// Was der Sender WIRKLICH schickt — am ankommenden Strom gemessen, nicht
    /// an einer Einstellung abgelesen.
    ///
    /// **Warum das hier gehoert und nicht in den Sender.** Der Sender weiss nur,
    /// was er ANGEFORDERT hat. Am 2026-08-07 stellte sich heraus, dass
    /// `h264_amf` die rollende Auffrischung wegen `usage=ultralowlatency`
    /// ungefragt mitfaehrt — eine Meldung von dort haette also das Gegenteil
    /// dessen behauptet, was auf der Leitung lag. Nur der Empfaenger sieht die
    /// Wahrheit.
    ///
    /// **Und es gilt auf jedem Betriebssystem.** Gelesen wird der Bitstrom
    /// (`recorder::is_keyframe`: AV1 ueber die OBU-Kette, H.264 ueber
    /// Annex-B-IDR) — kein System-Aufruf, keine Treiberfrage. Dieselbe Quelle
    /// laeuft unter Windows, Linux und macOS.
    ///
    /// **Was es NICHT unterscheiden kann:** ein Vollbild, das ein Zuschauer
    /// angefordert hat, sieht genauso aus wie ein periodisches. Deshalb meldet
    /// die Auswertung Zahlen und keine Diagnose — der Abstand entscheidet.
    pub fn sendeart(&self) -> Sendeart {
        Sendeart {
            vollbilder: self.keyframes,
            abstand_ms: self.keyframe_abstand.map(|d| d.as_millis() as u64),
            bytes: self.keyframe_bytes,
            her_ms: self.letztes_keyframe.map(|t| t.elapsed().as_millis() as u64),
        }
    }

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
            // Liegt das Bild im Grafikspeicher, muss es herunter — der
            // Renderer erwartet Ebenen im Hauptspeicher.
            //
            // Welche Formate das sind und warum die Liste vollstaendig sein
            // MUSS, steht bei [`AUF_GPU_FORMATE`].
            let auf_gpu = AUF_GPU_FORMATE.contains(&frame.format());
            // Der Weg am Hauptspeicher vorbei — nur wenn angefordert, nur bei
            // einem Format, fuer das es eine Bruecke gibt, und nur, solange sie
            // traegt. Scheitert sie, wird sie nicht wieder versucht und es geht
            // unten normal weiter.
            let zerocopy_versucht = crate::zerocopy::bruecke_moeglich(frame.format())
                && crate::zerocopy::angefordert();
            if zerocopy_versucht {
                let (fertig, dauer) = crate::zerocopy::bild_ohne_umweg(
                    &mut self.bruecke,
                    &frame,
                    self.zulauf.kasten(),
                    &self.geraet,
                );
                self.bruecke_us += dauer;
                if let Some(f) = fertig {
                    // Der Fingerabdruck dieses Bildes entsteht im Renderer und
                    // kommt spaeter zurueck; hier wird nur vermerkt, dass eine
                    // Antwort aussteht.
                    self.zulauf.bild_hinaus();
                    out.push(f);
                    continue;
                }
            }
            // Steht der GPU-Weg, sind die Abdruecke dieses Decoders GPU-Abdruecke
            // — ein CPU-Abdruck dazwischen waere mit ihnen nicht vergleichbar
            // und gaelte dem Waechter als „veraendert". Genau das passiert bei
            // jedem Bild, das mangels freiem Ringplatz hier landet. Solche
            // Bilder zaehlen deshalb gar nicht mit; es sind wenige, und eine
            // Stichprobe weniger schadet nichts (s. `crate::einfrieren`).
            //
            // **Es muss DIESES Bild sein, nicht die Bruecke im Allgemeinen.**
            // Zuerst stand hier `angefordert() && matches!(self.bruecke,
            // Some(Some(_)))`, und das ist im Lauf am 2026-08-06 aufgefallen:
            // nach dem Rueckfall auf Software (`auf_software`) bleibt die
            // Bruecke gebaut stehen, waehrend die Bilder als `YUV420P10LE`
            // ankommen. Die Bedingung war also weiter erfuellt, es gingen aber
            // keine GPU-Bilder mehr hinaus — der Waechter bekam von KEINER
            // Seite mehr ein Bild und war fuer den Rest der Sitzung blind.
            // Sichtbar allein daran, dass die Takt-Diagnose verstummte.
            //
            // **Der Satz „nach dem Rueckfall bleibt die Bruecke gebaut stehen"
            // gilt seit dem 2026-08-08 nicht mehr**:
            // `frischer_software_decoder` gibt sie jetzt frei (`Some(None)`),
            // weil sie sonst bis zum Sitzungsende Speicher hielte. Die
            // Bedingung bleibt trotzdem bildweise — der zweite, haeufigere Fall
            // (kein freier Ringplatz, waehrend die Bruecke steht) ist davon
            // unberuehrt.
            let gpu_weg_steht = zerocopy_versucht && matches!(self.bruecke, Some(Some(_)));
            if auf_gpu {
                let vor = std::time::Instant::now();
                let ergebnis = in_den_hauptspeicher(&frame, &mut self.hw_ziel);
                self.ruecklesen_us += vor.elapsed().as_micros() as u64;
                if let Err(e) = ergebnis {
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
                if !gpu_weg_steht {
                    self.wacht.bild(&f.planes);
                }
                self.unbrauchbare_bilder = 0;
                out.push(f);
            } else {
                // Ein Bild kam heraus, anzeigen laesst es sich nicht — der
                // einzige Weg, auf dem ein Standbild an ALLEN Waechtern
                // vorbeikommt (s. [`MAX_UNBRAUCHBARE_BILDER`]).
                self.unbrauchbare_bilder = self.unbrauchbare_bilder.saturating_add(1);
            }
        }
        // Was der Renderer inzwischen gerechnet hat, in den Waechter geben.
        // `true` heisst: es kommt nichts mehr — dann ist der GPU-Weg
        // aufzugeben, sonst liefe er ohne Waechter weiter.
        if self.zulauf.einspeisen(&mut self.wacht) {
            crate::zerocopy::abschalten("es kommen keine Fingerabdruecke zurueck");
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
            // Nur beim WECHSEL melden. Ein Format, das wir nicht koennen, kommt
            // in JEDEM Bild wieder — bei 60 fps waeren das 60 gleiche Zeilen je
            // Sekunde, waehrend das Bild steht. Das war die einzige
            // Wiederholmeldung dieser Datei ohne Bremse; `send_packet` meldet
            // seit jeher nur den ersten einer Serie.
            static ZULETZT: std::sync::Mutex<Option<Pixel>> = std::sync::Mutex::new(None);
            let mut zuletzt = ZULETZT.lock().unwrap_or_else(|e| e.into_inner());
            if *zuletzt != Some(other) {
                *zuletzt = Some(other);
                eprintln!("pulse-player: Pixelformat {other:?} wird nicht unterstuetzt");
            }
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
        // Beide werden erst in `session.rs` gesetzt: der Decoder kennt die
        // Zugriffseinheit nicht mehr, aus der das Bild stammt.
        rtp_ts: None,
        clock_rate: 0,
        width,
        height,
        format: layout,
        planes,
        strides,
        ten_bit,
        full_range: matches!(frame.color_range(), ffmpeg::color::Range::JPEG),
        farbe: farbangaben_von(frame, height),
        gpu: None,
        pool: pool.clone(),
    })
}

/// Wie [`farbangaben_von`], aber auch fuer `zerocopy::uebergabe` erreichbar —
/// eine zweite Ableitung dort liefe beim naechsten Umbau auseinander.
pub(crate) fn farbangaben_fuer(frame: &ffmpeg::util::frame::video::Video) -> Farbangaben {
    farbangaben_von(frame, frame.height())
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
    // Der Fingerabdruck und der Einfrier-Nachweis werden seit 2026-08-05 in
    // `crate::einfrieren` gepflegt und dort auch geprueft.

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
            // Ausdruecklich OHNE CUDA-Ausgabe: dieser Test gilt dem hwaccel auf
            // dem nativen Decoder. Der CUDA-Kandidat traegt ebenfalls ein
            // `hw`, sitzt aber auf `*_cuvid` und wuerde die Suche nach dem
            // ersten `hw`-Kandidaten sonst abfangen.
            let liste = candidates_mit(codec, true, false);
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
        let hw = candidates_mit(Codec::Av1, true, false)
            .into_iter()
            .find_map(|k| k.hw)
            .expect("hwaccel-Kandidat fehlt");
        #[cfg(windows)]
        assert_eq!(hw, Hwaccel::D3d11va);
        #[cfg(not(windows))]
        assert_eq!(hw, Hwaccel::Vaapi);
    }

    /// Mit eingeschalteter CUDA-Ausgabe steht cuvid ZWEIMAL da: erst mit
    /// Geraet, dann ohne. Der zweite Eintrag ist der Rueckfall — laesst sich
    /// das CUDA-Geraet nicht anlegen, muss cuvid trotzdem drankommen, statt
    /// still auf den nativen hwaccel oder auf Software durchzufallen.
    #[test]
    fn cuda_ausgabe_haelt_den_rueckfall_offen() {
        for (codec, cuvid) in [(Codec::Av1, "av1_cuvid"), (Codec::H264, "h264_cuvid")] {
            let liste = candidates_mit(codec, true, true);
            let mit_geraet = liste
                .iter()
                .position(|k| k.name == cuvid && k.hw == Some(Hwaccel::Cuda))
                .expect("cuvid mit CUDA-Geraet fehlt");
            let ohne_geraet = liste
                .iter()
                .position(|k| k.name == cuvid && k.hw.is_none())
                .expect("Rueckfall auf cuvid ohne Geraet fehlt");
            assert_eq!(mit_geraet, 0, "der CUDA-Weg gehoert nach vorn: {liste:?}");
            assert!(
                mit_geraet < ohne_geraet,
                "der Rueckfall muss HINTER dem CUDA-Weg stehen: {liste:?}"
            );
            // Und der native hwaccel darf dahinter nicht verlorengehen.
            assert!(
                liste.iter().any(|k| k.hw.is_some() && k.hw != Some(Hwaccel::Cuda)),
                "der plattform-eigene hwaccel fehlt: {liste:?}"
            );
        }
    }

    /// Abgeschaltet muss GENAU der Weg von vor dem 2026-08-07 herauskommen:
    /// cuvid einmal, ohne Geraet. Sonst waere der Notausgang keiner.
    #[test]
    fn cuda_ausgabe_abgeschaltet_ist_der_alte_weg() {
        let liste = candidates_mit(Codec::Av1, true, false);
        assert!(
            !liste.iter().any(|k| k.hw == Some(Hwaccel::Cuda)),
            "abgeschaltet darf kein CUDA-Geraet auftauchen: {liste:?}"
        );
        assert_eq!(
            liste.iter().filter(|k| k.name == "av1_cuvid").count(),
            1,
            "cuvid genau einmal: {liste:?}"
        );
        assert_eq!(liste.first().unwrap().name, "av1_cuvid", "cuvid zuerst: {liste:?}");
    }

    /// Die Hardware-Sperre (`PULSE_PLAYER_HWDEC=0`) muss ueber dem
    /// CUDA-Schalter stehen — sonst haette die Notbremse fuer den GPU-Haenger
    /// auf AMD-APUs eine Luecke.
    #[test]
    fn hwdec_sperre_schlaegt_cuda_schalter() {
        let liste = candidates_mit(Codec::Av1, false, true);
        assert!(
            !liste.iter().any(|k| k.hardware()),
            "ohne Hardware darf auch kein CUDA-Weg entstehen: {liste:?}"
        );
    }

    /// Der Grund, warum dieser Test existiert: `convert` lehnt jedes Bild ab,
    /// dessen Pixelformat es nicht kennt. Steht ein Geraetetyp in der
    /// Kandidatenliste, aber sein Bildformat nicht in der Abholung von
    /// [`VideoDecoder::drain`], liefert der Decoder sauber und der Zuschauer
    /// sieht ein weisses Fenster — ohne dass irgendwo ein Fehler steht, der
    /// nach der Ursache aussieht. Am 2026-08-04 mit D3D11 genau so passiert.
    #[test]
    fn jeder_geraetetyp_hat_ein_abgeholtes_bildformat() {
        for art in [Hwaccel::Vaapi, Hwaccel::D3d11va, Hwaccel::Cuda] {
            let format = art.bildformat();
            assert!(
                AUF_GPU_FORMATE.contains(&format),
                "{art:?} liefert {format:?}, aber drain holt es nicht herunter — \
                 das gibt ein weisses Fenster ohne Fehlermeldung"
            );
        }
    }

    /// Gegenprobe zum Test darueber: er muss ein FEHLENDES Format bemerken
    /// koennen. Ohne sie waere „alle drei sind dabei" nicht davon zu
    /// unterscheiden, dass die Pruefung gar nichts vergleicht.
    #[test]
    fn die_formatpruefung_kann_anschlagen() {
        let unbeteiligt = ffmpeg::format::Pixel::YUV420P;
        assert!(
            !AUF_GPU_FORMATE.contains(&unbeteiligt),
            "ein Hauptspeicher-Format darf nicht als GPU-Format gelten"
        );
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
        let mut d = VideoDecoder::new(Codec::Av1, Some(hw), None).expect("Decoder");
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
        let mut d = VideoDecoder::new(Codec::Av1, Some(false), None).expect("AV1-Software-Decoder");
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
        let mut d = VideoDecoder::new(Codec::Av1, Some(false), None).expect("AV1-Software-Decoder");
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
        let mut d = VideoDecoder::new(Codec::Av1, Some(false), None).expect("AV1-Software-Decoder");
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
        let mut d = VideoDecoder::new(Codec::Av1, Some(false), None).expect("AV1-Software-Decoder");
        d.awaiting_keyframe = false;
        d.skipped_before_keyframe = 7;
        d.rebuild("Test", std::time::Instant::now()).expect("Neuaufbau");
        assert!(d.awaiting_keyframe, "nach dem Neuaufbau fehlt der Einstiegspunkt wieder");
        assert_eq!(d.skipped_before_keyframe, 0, "Zaehler gehoert zum neuen Anlauf");
    }

    /// Der Neuaufbau muss auf Software gehen — waere Hardware erlaubt, liefe
    /// er in denselben defekten CUDA-Kontext zurueck.
    #[test]
    fn neuaufbau_landet_auf_software() {
        let mut d = VideoDecoder::new(Codec::H264, Some(false), None).expect("Software-Decoder");
        d.consecutive_errors = neuaufbau::ERROR_LIMIT;
        d.rebuild("Test", std::time::Instant::now()).expect("Neuaufbau");
        assert!(!d.hardware, "Neuaufbau muss Software sein, ist {}", d.name);
        assert_eq!(d.consecutive_errors, 0, "Zaehler muss fuer die Anlaufphase zurueckgesetzt sein");
        assert_eq!(d.rebuilds.anzahl(), 1);
    }

    /// Der Software-Weg muss auf jeder Maschine funktionieren — ohne den
    /// waere der Player auf fremder Hardware wertlos.
    #[test]
    fn software_decoder_laesst_sich_oeffnen() {
        let d = VideoDecoder::new(Codec::H264, Some(false), None);
        assert!(d.is_ok(), "H.264-Software-Decoder fehlt: {:?}", d.err());
        assert!(!d.unwrap().hardware);
    }

    /// **Reproduktion Befund 15** — ein unbekanntes Pixelformat ergibt ein
    /// dauerhaftes Standbild, und die Meldung dazu hat als einzige
    /// Wiederholmeldung der Datei KEINE Ratenbremse.
    ///
    /// Geprueft wird der messbare Teil: dieselbe Ablehnung 100 Mal
    /// hintereinander muss EINE Zeile ergeben (bzw. eine je Formatwechsel),
    /// nicht 100. Bei 60 fps sind das sonst 60 identische Zeilen je Sekunde.
    ///
    /// Der zweite Teil des Befunds — es fehlt ein Zaehler „Einheit angenommen,
    /// aber kein Bild geliefert", weshalb weder `neuaufbau::classify`
    /// (`consecutive_errors` steht nach dem erfolgreichen `send_packet` auf 0)
    /// noch der Einfrier-Waechter (`letzte_aenderung` bleibt `None`, weil nie
    /// ein Bild ankommt) je ausloesen kann — ist hier nur festgehalten und
    /// nicht als Zusicherung pruefbar: es gibt kein Feld und keine Kennzahl,
    /// gegen die sich das schreiben liesse. Genau das IST der Befund.
    ///
    /// **Der Satz „es gibt kein Feld und keine Kennzahl" gilt seit dem
    /// 2026-08-08 nicht mehr**: es gibt jetzt `unbrauchbare_bilder` samt
    /// [`MAX_UNBRAUCHBARE_BILDER`], und nach einer Sekunde solcher Bilder endet
    /// die Sitzung mit einer Meldung statt mit einem Standbild. Hier
    /// nachgewiesen wird das trotzdem nicht — dafuer braeuchte es einen
    /// Decoder, der wirklich `YUV444P` liefert, also einen 4:4:4-Strom.
    ///
    /// Der Umweg ueber ein zweites Exemplar des Testbinaers ist noetig, weil
    /// `convert` per `eprintln!` meldet und der Testlaeufer stderr nicht
    /// programmatisch zugaenglich macht.
    #[test]
    fn repro_15_unbekanntes_pixelformat_meldet_ohne_ratenbremse() {
        use ffmpeg::format::Pixel;
        const KIND: &str = "PULSE_REPRO15_KIND";
        const WIEDERHOLUNGEN: usize = 100;

        // Kindlauf: nur ablehnen lassen, nicht pruefen.
        if std::env::var(KIND).is_ok() {
            let pool = PlanePool::default();
            for format in [Pixel::YUV444P, Pixel::YUV422P] {
                for _ in 0..WIEDERHOLUNGEN {
                    let f = ffmpeg::util::frame::video::Video::new(format, 320, 240);
                    assert!(
                        convert(&f, &pool).is_none(),
                        "{format:?} darf nicht angenommen werden"
                    );
                }
            }
            return;
        }

        let exe = std::env::current_exe().expect("Testbinary");
        let aus = std::process::Command::new(exe)
            .args([
                "repro_15_unbekanntes_pixelformat_meldet_ohne_ratenbremse",
                // `--include-ignored` statt `--ignored`: seit die Behebung
                // steht, traegt der Test kein `#[ignore]` mehr — mit
                // `--ignored` liefe im Kindlauf gar kein Test und stderr
                // bliebe leer.
                "--include-ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(KIND, "1")
            .output()
            .expect("Kindlauf startbar");
        let err = String::from_utf8_lossy(&aus.stderr);
        assert!(
            aus.status.success(),
            "Kindlauf fehlgeschlagen:\n{}\n{err}",
            String::from_utf8_lossy(&aus.stdout)
        );

        let zaehle = |muster: &str| {
            err.lines()
                .filter(|z| z.contains("Pixelformat") && z.contains(muster))
                .count()
        };
        let yuv444 = zaehle("YUV444P");
        let yuv422 = zaehle("YUV422P");
        eprintln!("Meldezeilen bei je {WIEDERHOLUNGEN} Ablehnungen: YUV444P={yuv444}, YUV422P={yuv422}");
        assert_eq!(
            yuv444, 1,
            "{WIEDERHOLUNGEN} gleiche Ablehnungen duerfen EINE Zeile ergeben, nicht {yuv444}"
        );
        assert_eq!(
            yuv422, 1,
            "der Formatwechsel darf genau eine weitere Zeile ergeben, nicht {yuv422}"
        );
    }

    /// **Reproduktion Befund 17** — nach dem Rueckfall auf Software bleiben
    /// Zero-Copy-Bruecke und `hw_ziel` belegt.
    ///
    /// `frischer_software_decoder` ersetzt `decoder`, `name`, `hardware` und
    /// die Zaehler; `self.bruecke` und `self.hw_ziel` bleiben unangetastet.
    /// Danach liefert der Decoder `YUV420P`/`YUV420P10LE`, fuer die
    /// `bruecke_moeglich` falsch ist — beide Halden werden nie wieder
    /// angefasst und nie freigegeben, und zwar genau in dem Moment, in dem die
    /// Grafikeinheit ohnehin in Not war.
    ///
    /// Hier geprueft wird der Anteil, der ohne Grafikhardware nachweisbar ist:
    /// der Bildpuffer in `hw_ziel`. Der Ring der Bruecke haengt an D3D11 und
    /// ist auf diesem Rechner nicht herstellbar; `bruecke` wird deshalb nur
    /// darauf geprueft, dass der Rueckfall den Zustand „versucht, keine
    /// Bruecke" nicht nach `None` (= „noch nicht versucht") zurueckdreht.
    #[test]
    fn repro_17_rueckfall_gibt_hw_ziel_nicht_frei() {
        use ffmpeg::format::Pixel;
        let mut d = VideoDecoder::new(Codec::H264, Some(false), None).expect("Software-Decoder");

        // Ein echter 1280x720-NV12-Puffer, wie ihn `in_den_hauptspeicher`
        // hinterlaesst — rund 1,4 MB, bei 1440p10 ein Vielfaches davon.
        d.hw_ziel = ffmpeg::util::frame::video::Video::new(Pixel::NV12, 1280, 720);
        d.bruecke = Some(None);
        let vorher: usize = (0..d.hw_ziel.planes()).map(|i| d.hw_ziel.data(i).len()).sum();
        assert!(vorher > 0, "der Vorher-Zustand muss wirklich Speicher halten");

        d.frischer_software_decoder().expect("Rueckfall auf Software");

        assert!(
            matches!(d.bruecke, Some(None)),
            "der Rueckfall darf „versucht, keine Bruecke\" nicht auf „noch nicht versucht\" zuruecksetzen"
        );
        let nachher: usize = (0..d.hw_ziel.planes()).map(|i| d.hw_ziel.data(i).len()).sum();
        eprintln!("hw_ziel: vor dem Rueckfall {vorher} Byte, danach {nachher} Byte");
        assert_eq!(
            d.hw_ziel.planes(),
            0,
            "hw_ziel muss nach dem Rueckfall leer sein, haelt aber weiter {nachher} Byte"
        );
    }
}
