//! Wer HDR wirklich trägt — und die Absage für alle anderen.
//!
//! Gegenstück zu [`super::auffrischung`] und aus demselben Grund gebaut: **ein
//! Strom, der unter dem Etikett „HDR" läuft und in Wahrheit SDR ist, ist
//! schlimmer als ein Start, der abbricht.** Der Zuschauer sieht dann ein Bild,
//! das plausibel aussieht, nur flau — und sucht den Fehler bei seinem Schirm.
//!
//! **HDR hängt an vier Dingen, und alle vier müssen stimmen:**
//!
//! 1. Der aufgenommene **Bildschirm** läuft in HDR. Läuft er es nicht, gibt es
//!    nichts zu holen: WGC liefert dann SDR-Bildpunkte, und keine spätere Stufe
//!    macht daraus wieder Spitzlichter.
//! 2. Der **Encode-Weg** ist der über D3D11. Nur dort sitzt der Farbwandler
//!    (`super::farbraum`), der scRGB nach PQ/BT.2020 bringt; der D3D12-Weg und
//!    der CPU-Weg nehmen fest BGRA entgegen.
//! 3. Der **Encoder** trägt HDR — Tabelle unten.
//! 4. Es wird in **10 bit** encodiert. Das ist keine zusätzliche Bedingung,
//!    sondern eine Folge: PQ verteilt seine Codewerte über einen Bereich von
//!    0,0001 bis 10 000 cd/m², und in 8 bit stehen dafür 256 Stufen zur
//!    Verfügung. Das Ergebnis sind sichtbare Ringe in jedem Verlauf. HDR
//!    schaltet 10 bit deshalb selbst ein, statt es vom Nutzer zu verlangen.
//!
//! **Warum hier eine Tabelle steht und keine Abfrage.** Dieselbe Erfahrung wie
//! beim Intra-Refresh: `avcodec_open2` nimmt Farbfelder, die der Encoder nicht
//! weiterreicht, klaglos entgegen. Ein `h264_amf`, dem man BT.2020 und PQ
//! anschreibt, öffnet ohne Murren — und schreibt es nicht in den Strom. Was ein
//! Encoder wirklich tut, steht am fertigen Strom, und was hier steht, ist dort
//! nachgesehen (`docs/2026-08-06-hdr-windows-amd.md`).

use anyhow::{Result, bail};
use ffmpeg_next as ffmpeg;
use ffmpeg_next::ffi::{
    AVFrame, AVFrameSideDataType, AVRational, av_frame_new_side_data, av_frame_remove_side_data,
};

use super::codec::VideoCodec;
use crate::capture::CaptureSource;
use crate::system::hdr::SchirmFarbe;

/// Trägt dieser FFmpeg-Encoder eine HDR-Signalisierung bis in den Strom?
///
/// `false` heißt **nicht** „die Hardware kann es nicht" — es heißt „wir haben
/// es hier nicht belegt". Der Unterschied steht je Zeile dabei, damit niemand
/// eine Absage für ein Naturgesetz hält.
fn traegt_hdr(encoder: &str) -> bool {
    match encoder {
        // **Der einzige belegte Weg.** FFmpegs `amfenc` reicht bei AV1 alles
        // durch, was HDR10 braucht: `color_primaries`, `color_trc` und
        // `colorspace` gehen als AMF-Eigenschaften an den Encoder
        // (`AMF_VIDEO_ENCODER_AV1_OUTPUT_{COLOR_PRIMARIES,
        // TRANSFER_CHARACTERISTIC,COLOR_PROFILE}`), und sobald ein Bild
        // `color_trc = SMPTE2084` trägt, baut `amf_save_hdr_metadata` daraus
        // die Mastering-Display- und Content-Light-Angaben und hängt sie über
        // `AMF_VIDEO_ENCODER_AV1_INPUT_HDR_METADATA` an. Ohne Patch, in der
        // ausgelieferten Fassung.
        "av1_amf" => true,
        // Alles andere: nein, und zwar begründet.
        //
        // * `h264_amf`/`hevc_amf` — HDR verlangt 10 bit (s. Modul-Kopf), und
        //   10-bit-H.264 wäre High 10, das kein Browser dekodiert; deshalb
        //   lässt schon `VideoCodec::supports_ten_bit` nur AV1 durch. HEVC wird
        //   ausgebaut. Es ist also keine Encoder-Grenze, sondern eine
        //   Produktentscheidung weiter oben.
        // * `*_d3d12va` — der Weg nimmt fest BGRA auf und hat keinen
        //   Farbwandler, der scRGB annähme. Er ist seit dem 2026-08-04 ohnehin
        //   nur noch die Gegenprobe hinter `PULSE_HQ_AMD_D3D12=1`.
        // * `*_qsv` — läuft über die CPU-Pipeline, also über swscale aus einem
        //   BGRA-Puffer. Derselbe Grund.
        // * `av1_nvenc` — **ungemessen, nicht ausgeschlossen.** NVENC kann
        //   HDR10, und FFmpegs `nvenc` reicht die Farbfelder durch; was fehlt,
        //   ist ein Lauf auf einer NVIDIA-Karte mit HDR-Schirm. Bis den jemand
        //   gemacht hat, wäre ein `true` hier eine Behauptung. Wer ihn macht:
        //   diese Zeile, ein Eintrag in `docs/` und die Absage unten fällt weg.
        _ => false,
    }
}

/// Der Encoder, den diese Kombination wirklich öffnen würde — dieselbe Frage
/// wie in [`super::auffrischung::encoder_name`], und bewusst über dieselbe
/// Funktion beantwortet. Zwei Fassungen davon liefen mit dem nächsten
/// Encode-Weg auseinander, und dann meldete eine Stelle eine Fähigkeit für
/// einen Encoder, den die andere gar nicht startet.
fn encoder_name(vendor: &str, codec: VideoCodec, push_url: &str) -> Option<&'static str> {
    super::auffrischung::encoder_name(vendor, codec, push_url)
}

/// Kann diese Maschine HDR senden — unabhängig davon, ob der Schirm gerade in
/// HDR läuft?
///
/// Das ist die Frage, die `health.gsr.hdr` beantwortet, und sie ist bewusst die
/// **Geräte**-Frage: die Oberfläche soll das Kästchen anbieten dürfen, auch
/// wenn HDR im Windows-Umschalter gerade aus ist. Sonst verschwände die Option
/// spurlos und niemand käme darauf, dass sie an einer Windows-Einstellung
/// hängt. Ob der Schirm mitspielt, sagt [`pruefen`] beim Start — mit einer
/// Meldung, die den Weg zur Abhilfe nennt.
pub fn verfuegbar(vendor: &str, codecs: &[String]) -> bool {
    codecs.iter().any(|slug| {
        let codec = VideoCodec::from_slug(slug);
        codec.supports_ten_bit()
            && encoder_name(vendor, codec, "").is_some_and(traegt_hdr)
    })
}

/// Darf dieser Stream in HDR laufen? Liefert bei Ja die Angaben des Schirms,
/// die als Mastering-Metadaten in den Strom gehen.
///
/// Einmal je Start aufzurufen, **bevor** die Aufnahme beginnt — das
/// Aufnahmeformat hängt an der Antwort (`capture::bildformat`), und eine
/// Aufnahme, die schon in BGRA läuft, ließe sich hinterher nicht mehr retten.
///
/// Die Meldungen nennen jeweils die Abhilfe, nicht nur den Befund. Ein „HDR
/// nicht verfügbar" ohne Grund führt zu Fehlersuche an der falschen Stelle —
/// beim Schirm-Fall ist die Abhilfe ein Windows-Schalter, beim Codec-Fall ein
/// anderes Kästchen in derselben Maske.
pub fn pruefen(
    vendor: &str,
    codec: VideoCodec,
    push_url: &str,
    quelle: &CaptureSource,
) -> Result<SchirmFarbe> {
    let Some(encoder) = encoder_name(vendor, codec, push_url) else {
        bail!("HDR verlangt, aber für {vendor} mit {codec:?} gibt es hier gar keinen Encoder");
    };
    if !codec.supports_ten_bit() {
        bail!(
            "HDR verlangt, aber {codec:?} kann hier kein 10 bit — und HDR ohne 10 bit wären \
             sichtbare Ringe in jedem Verlauf (Begründung: encode/hdr.rs). Abhilfe: AV1 wählen."
        );
    }
    if !traegt_hdr(encoder) {
        bail!(
            "HDR verlangt, aber '{encoder}' trägt es nicht bis in den Strom. Belegt ist heute \
             allein AV1 über AMF (AMD); NVIDIA ist ungemessen, nicht ausgeschlossen. \
             Begründung je Encoder: encode/hdr.rs"
        );
    }

    // Der Schirm. **Zuletzt geprüft, obwohl es die häufigste Absage sein wird**
    // — die Abfrage kostet eine DXGI-Aufzählung, die Tabellen darüber nichts.
    let ziel = quelle.resolve()?;
    let schirm = crate::system::hdr::schirm_farbe(ziel.hmonitor())?;
    let Some(schirm) = schirm else {
        bail!(
            "HDR verlangt, aber zu diesem Bildschirm gibt es keinen DXGI-Ausgang — das passiert \
             bei virtuellen Anzeigen (Fernwartung, manche Aufnahme-Treiber). Ohne den Ausgang \
             wissen wir weder, ob HDR läuft, noch mit welchen Leuchtdichten."
        );
    };
    if !schirm.hdr_aktiv {
        bail!(
            "HDR verlangt, aber dieser Bildschirm läuft gerade in SDR ({}). Die Aufnahme bekäme \
             dann bereits heruntergerechnete Bildpunkte, und der Strom trüge das HDR-Etikett \
             trotzdem. Abhilfe: in den Windows-Anzeigeeinstellungen „HDR verwenden\" für diesen \
             Bildschirm einschalten.",
            schirm.beschreibung()
        );
    }
    Ok(schirm)
}

// ── Was der Encoder in den Strom schreibt ───────────────────────────────────

/// `AVMasteringDisplayMetadata` aus FFmpeg 8.1
/// (`libavutil/mastering_display_metadata.h`).
///
/// **Von Hand gespiegelt, weil `ffmpeg-sys-next` diesen Struct nicht bindet** —
/// es kennt den Aufzählungswert für die Nutzlast und `av_frame_new_side_data`,
/// aber nicht die Form der Nutzlast selbst. Gleiche Lage und gleiche Lösung wie
/// bei `AVD3D11VADeviceContext` in `hwctx.rs`; ein Layout-Fehler fällt dort wie
/// hier sofort auf (falsche Zahlen im Strom, nicht stiller Unsinn).
#[repr(C)]
struct AVMasteringDisplayMetadata {
    /// Rot, Grün, Blau — je x und y in CIE-1931.
    display_primaries: [[AVRational; 2]; 3],
    white_point: [AVRational; 2],
    min_luminance: AVRational,
    max_luminance: AVRational,
    has_primaries: std::os::raw::c_int,
    has_luminance: std::os::raw::c_int,
}

/// `AVContentLightMetadata` aus derselben Kopfdatei.
#[repr(C)]
#[allow(non_snake_case)]
struct AVContentLightMetadata {
    MaxCLL: std::os::raw::c_uint,
    MaxFALL: std::os::raw::c_uint,
}

/// **Der Nenner, mit dem `amfenc.c` rechnet.** Es multipliziert unsere Brüche
/// mit 50 000 (Primärvalenzen) bzw. 10 000 (Leuchtdichten) und schneidet ab.
/// Wählen wir genau diese Nenner, geht beim Umweg über den Bruch nichts
/// verloren; mit einem anderen Nenner käme je nach Wert eine Einheit weniger
/// heraus, als der Schirm gemeldet hat.
const NENNER_FARBORT: i32 = 50_000;
const NENNER_LEUCHTDICHTE: i32 = 10_000;

/// Die Farb-Signalisierung, die in den AV1-Sequenzkopf geht.
///
/// Das ist der **wichtigere** der beiden Teile: ohne diese drei Angaben deutet
/// jeder Zuschauer den Strom als BT.709/SDR, und alles Weitere ist einerlei.
/// Sie werden einmal beim Öffnen gesetzt, nicht je Bild — der Sequenzkopf
/// entsteht einmal.
///
/// Der Wertebereich bleibt **Studio** und ist hier bewusst mit aufgeführt: er
/// muss zu dem passen, was der Video-Prozessor davor schreibt
/// (`farbraum::AUSGANG_HDR10` endet auf `STUDIO`). Steht an einer der beiden
/// Stellen etwas anderes, ist das Bild um den Faktor 219/255 zu flau oder zu
/// hart — ein Fehler, den man dem Encoder anlastet.
pub fn signalisieren(encoder: &mut ffmpeg::encoder::video::Video, schirm: Option<&SchirmFarbe>) {
    let Some(schirm) = schirm else {
        return sdr_signalisieren(encoder);
    };
    encoder.set_colorspace(ffmpeg::color::Space::BT2020NCL);
    encoder.set_color_range(ffmpeg::color::Range::MPEG);
    eprintln!(
        "[encode] HDR-Signalisierung: BT.2020 mit PQ (SMPTE 2084), Studio-Bereich. \
         Mastering-Angaben: {}",
        schirm.beschreibung()
    );
    // **Für Primärvalenzen und Transferkurve gibt es in `ffmpeg-next` keine
    // Setzer** — nur Leser. Deshalb direkt ins Feld; dieselbe Lage wie bei den
    // D3D11VA-Strukturen in `hwctx.rs`, nur eine Ebene harmloser: das sind zwei
    // Aufzählungswerte in einem Kontext, der uns gehört und noch nicht geöffnet
    // ist.
    //
    // Ohne sie ist alles andere umsonst: `colorspace` allein sagt nur, wie aus
    // YCbCr wieder RGB wird — dass die Werte in BT.2020-Primärvalenzen liegen
    // und einer PQ-Kurve folgen, steht ausschließlich in diesen beiden Feldern.
    // Ein Zuschauer ohne sie zeigt HDR-Werte als SDR: viel zu dunkel und
    // entsättigt.
    unsafe {
        let ctx = encoder.as_mut_ptr();
        (*ctx).color_primaries = ffmpeg::ffi::AVColorPrimaries::AVCOL_PRI_BT2020;
        (*ctx).color_trc = ffmpeg::ffi::AVColorTransferCharacteristic::AVCOL_TRC_SMPTE2084;
    }
}

/// Der 10-bit-SDR-Fall — und **das ist eine Fehlerbehebung, keine
/// Vollständigkeit.**
///
/// Am 2026-08-06 am fertigen Strom nachgesehen: ein 10-bit-Lauf, der nur
/// `colorspace` und `color_range` setzte, meldete `color_transfer=smpte2084`
/// und `color_primaries=unknown` — er behauptete also **PQ**, obwohl er
/// gewöhnliches SDR enthielt. Ein Zuschauer, der die Angabe befolgt, zeigt das
/// Bild dadurch massiv zu dunkel.
///
/// Die Ursache liegt in `amfenc_av1.c`: der Zweig, der Kurve und
/// Primärvalenzen an AMF weitergibt, hängt an
/// `avctx->color_primaries != UNSPECIFIED` (Zeile 274). Ohne gesetzte
/// Primärvalenzen wird er übersprungen, und AMF nimmt für 10 bit von sich aus
/// PQ an. **Es genügt also nicht, nichts zu behaupten — man muss BT.709
/// ausdrücklich sagen, sonst behauptet der Treiber etwas anderes.**
///
/// Der 8-bit-Weg ruft das hier NICHT auf: dort ist AMFs Vorgabe BT.709, und der
/// Weg ist so seit Langem verifiziert. Ihn auf Verdacht mitzuändern hieße, eine
/// belegte Kette gegen eine unbelegte zu tauschen.
fn sdr_signalisieren(encoder: &mut ffmpeg::encoder::video::Video) {
    encoder.set_colorspace(ffmpeg::color::Space::BT709);
    encoder.set_color_range(ffmpeg::color::Range::MPEG);
    unsafe {
        let ctx = encoder.as_mut_ptr();
        (*ctx).color_primaries = ffmpeg::ffi::AVColorPrimaries::AVCOL_PRI_BT709;
        (*ctx).color_trc = ffmpeg::ffi::AVColorTransferCharacteristic::AVCOL_TRC_BT709;
    }
}

/// Einem Bild die HDR10-Metadaten anhängen, die AMF in den Strom schreibt.
///
/// **Warum je Bild und nicht einmal.** FFmpegs AMF-Zweig liest sie aus den
/// Begleitdaten des Bildes (`amf_save_hdr_metadata`), und zwar bei jedem
/// Einschieben; er kennt keinen Weg, sie einmal zu hinterlegen. Bei einem Strom
/// mit rollendem Intra-Refresh ist das sogar der bessere Weg: dort gibt es nach
/// dem Start keine Vollbilder mehr, an denen sich statische Metadaten sonst
/// üblicherweise wiederholen — ein später dazukommender Zuschauer bekäme sie
/// nie.
///
/// Die Kosten sind zwei kleine Speicheranforderungen je Bild. Bei 60 Bildern in
/// der Sekunde ist das gegenüber allem anderen in diesem Weg nicht messbar; und
/// FFmpeg fordert auf demselben Pfad ohnehin je Bild einen AMF-Puffer an.
///
/// **Mehrfach auf DASSELBE Bild anwendbar — und das ist eine Zusage, keine
/// Nebenwirkung.** `av_frame_new_side_data` hängt an, es ersetzt nicht: zweimal
/// gerufen, stehen zwei Mastering-Einträge am Bild (nachgewiesen in
/// `tests::ffmpeg_haengt_begleitdaten_an`). Solange jeder Tick ein frisches
/// `AVFrame` aus dem Pool zog, war das folgenlos. Seit die Pipeline bei
/// stehendem Bild dasselbe gewandelte Bild erneut einschiebt
/// (`pipeline_hw::run`), ist es das nicht mehr — ein Standbild ließe die
/// Begleitdaten über die Laufzeit des Streams unbegrenzt anwachsen. Deshalb
/// räumt diese Funktion beide Arten vorher weg.
///
/// **`color_trc` am BILD ist die Zündung**, nicht nur eine Wiederholung der
/// Encoder-Einstellung: `amfenc.c` prüft `frame->color_trc == AVCOL_TRC_SMPTE2084`
/// und überspringt die Metadaten sonst vollständig. Ohne diese Zeile bliebe
/// alles Weitere hier wirkungslos, ohne dass irgendwo etwas fehlschlüge.
///
/// # Safety
///
/// `frame` muss ein gültiges, beschreibbares `AVFrame` sein, das anschließend
/// eingeschoben und danach freigegeben wird — die Begleitdaten hängen an ihm
/// und werden mit ihm frei.
pub unsafe fn metadaten_anhaengen(frame: *mut AVFrame, schirm: &SchirmFarbe) -> Result<()> {
    unsafe {
        (*frame).color_trc = ffmpeg::ffi::AVColorTransferCharacteristic::AVCOL_TRC_SMPTE2084;
        (*frame).colorspace = ffmpeg::ffi::AVColorSpace::AVCOL_SPC_BT2020_NCL;
        (*frame).color_primaries = ffmpeg::ffi::AVColorPrimaries::AVCOL_PRI_BT2020;
        (*frame).color_range = ffmpeg::ffi::AVColorRange::AVCOL_RANGE_MPEG;

        let ort = |v: f32| AVRational {
            num: (v * NENNER_FARBORT as f32).round() as i32,
            den: NENNER_FARBORT,
        };
        let leuchte = |v: f32| AVRational {
            num: (v * NENNER_LEUCHTDICHTE as f32).round() as i32,
            den: NENNER_LEUCHTDICHTE,
        };
        let display = AVMasteringDisplayMetadata {
            display_primaries: [
                [ort(schirm.primaervalenzen[0][0]), ort(schirm.primaervalenzen[0][1])],
                [ort(schirm.primaervalenzen[1][0]), ort(schirm.primaervalenzen[1][1])],
                [ort(schirm.primaervalenzen[2][0]), ort(schirm.primaervalenzen[2][1])],
            ],
            white_point: [ort(schirm.weisspunkt[0]), ort(schirm.weisspunkt[1])],
            min_luminance: leuchte(schirm.min_nits),
            max_luminance: leuchte(schirm.max_nits),
            has_primaries: 1,
            has_luminance: 1,
        };
        seitendaten_schreiben(
            frame,
            AVFrameSideDataType::AV_FRAME_DATA_MASTERING_DISPLAY_METADATA,
            &display,
        )?;

        // Was wirklich im Bild vorkommt, wissen wir nicht — der Schirm ist die
        // obere Schranke, und eine wahre obere Schranke ist besser als eine
        // geratene genaue Zahl (Begründung ausführlich in
        // `farbraum::hdr10_metadaten`).
        let licht = AVContentLightMetadata {
            MaxCLL: schirm.max_nits as u32,
            MaxFALL: schirm.max_vollbild_nits as u32,
        };
        seitendaten_schreiben(
            frame,
            AVFrameSideDataType::AV_FRAME_DATA_CONTENT_LIGHT_LEVEL,
            &licht,
        )?;
    }
    Ok(())
}

/// Begleitdaten der passenden Größe anlegen und den Wert hineinkopieren.
///
/// # Safety
///
/// Wie [`metadaten_anhaengen`]; `T` muss die Form haben, die FFmpeg unter
/// `art` erwartet.
unsafe fn seitendaten_schreiben<T>(
    frame: *mut AVFrame,
    art: AVFrameSideDataType,
    wert: &T,
) -> Result<()> {
    let groesse = std::mem::size_of::<T>();
    // **Erst weg, dann neu.** `av_frame_new_side_data` prüft nicht, ob diese
    // Art schon am Bild hängt — es hängt eine zweite an.
    //
    // Das ist kein Sonderfall der Standbild-Wiederverwendung, sondern dieselbe
    // Regel, unter der `encoder_hw::send_avframe` seit jeher `pict_type` je
    // Bild ZURÜCKSETZT statt nur zu setzen: **die Bilder kommen aus einem Pool
    // und werden wiederverwendet, also muss jedes bildgebundene Feld gesetzt
    // werden, nicht ergänzt.** Wer hier eine dritte Begleitdaten-Art aufnimmt,
    // räumt sie ebenso vorher weg. Der Aufruf ist ein Nulltarif, wenn nichts
    // da ist.
    unsafe { av_frame_remove_side_data(frame, art) };
    let sd = unsafe { av_frame_new_side_data(frame, art, groesse) };
    if sd.is_null() {
        bail!("av_frame_new_side_data({art:?}) lieferte NULL — kein Speicher");
    }
    unsafe { std::ptr::copy_nonoverlapping(std::ptr::from_ref(wert).cast::<u8>(), (*sd).data, groesse) };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ein Schirm, wie ihn DXGI meldet — Zahlen aus dem Gerät dieser Maschine,
    /// damit sie plausibel sind. Für die Begleitdaten-Tests ist ihr Wert
    /// gleichgültig, ihre Form nicht.
    fn schirm() -> SchirmFarbe {
        SchirmFarbe {
            hdr_aktiv: true,
            bits_je_kanal: 10,
            max_nits: 463.0,
            max_vollbild_nits: 463.0,
            min_nits: 0.5,
            primaervalenzen: [[0.6416, 0.3300], [0.2939, 0.6220], [0.1494, 0.0546]],
            weisspunkt: [0.3125, 0.3291],
        }
    }

    /// **Der Nachweis, dass die Sorge berechtigt war.** Die Analyse vom
    /// 2026-08-06 nannte das Anwachsen der Begleitdaten als ungeprüften
    /// Fallstrick der Bild-Wiederverwendung; hier steht die Antwort. FFmpegs
    /// `av_frame_new_side_data` **hängt an** — zweimal gerufen, hat das Bild
    /// zwei Einträge derselben Art.
    ///
    /// Der Test prüft FFmpeg, nicht uns. Er steht trotzdem hier: fiele die
    /// Zusicherung eines Tages weg (FFmpeg räumte selbst), wäre das Entfernen
    /// in [`seitendaten_schreiben`] überflüssig — und wer es entfernen will,
    /// soll sehen, worauf es sich stützt.
    #[test]
    fn ffmpeg_haengt_begleitdaten_an() {
        unsafe {
            let frame = ffmpeg::ffi::av_frame_alloc();
            assert!(!frame.is_null());
            for _ in 0..2 {
                let sd = av_frame_new_side_data(
                    frame,
                    AVFrameSideDataType::AV_FRAME_DATA_CONTENT_LIGHT_LEVEL,
                    std::mem::size_of::<AVContentLightMetadata>(),
                );
                assert!(!sd.is_null());
            }
            assert_eq!(
                (*frame).nb_side_data,
                2,
                "wenn FFmpeg hier 1 liefert, räumt es selbst — dann ist das \
                 av_frame_remove_side_data in seitendaten_schreiben überflüssig"
            );
            let mut f = frame;
            ffmpeg::ffi::av_frame_free(&mut f);
        }
    }

    /// Und der Nachweis, dass unser Weg es abfängt: dasselbe Bild dreimal
    /// beschrieben trägt danach **zwei** Einträge, nicht sechs.
    ///
    /// Das ist die Bedingung, unter der `pipeline_hw::run` bei stehendem Bild
    /// dasselbe gewandelte Bild erneut einschieben darf.
    #[test]
    fn wiederholtes_anhaengen_waechst_nicht() {
        unsafe {
            let frame = ffmpeg::ffi::av_frame_alloc();
            assert!(!frame.is_null());
            let s = schirm();
            for _ in 0..3 {
                metadaten_anhaengen(frame, &s).expect("Begleitdaten anhängen");
            }
            assert_eq!(
                (*frame).nb_side_data,
                2,
                "je Art genau einer — sonst wächst ein stehendes Bild über die \
                 Laufzeit des Streams zu"
            );
            assert_eq!(
                (*frame).color_trc,
                ffmpeg::ffi::AVColorTransferCharacteristic::AVCOL_TRC_SMPTE2084,
                "die Zündung für amfenc muss stehenbleiben"
            );
            let mut f = frame;
            ffmpeg::ffi::av_frame_free(&mut f);
        }
    }

    /// AV1 über AMF ist der belegte Weg — und H.264 auf derselben Karte ist es
    /// nicht. Der Test hält beides fest, weil AMD seit dem 2026-08-04 mit
    /// **beiden** Codecs über AMF geht: „läuft über AMF" ist damit kein
    /// Argument mehr dafür, dass etwas HDR trägt.
    #[test]
    fn auf_amd_traegt_nur_av1_hdr() {
        assert!(traegt_hdr(encoder_name("amd", VideoCodec::Av1, "").unwrap()));
        assert!(!traegt_hdr(encoder_name("amd", VideoCodec::H264, "").unwrap()));
    }

    /// Die Fähigkeitsmeldung darf nur dort Ja sagen, wo beides zusammenkommt:
    /// ein Encoder, der HDR trägt, UND ein Codec, der 10 bit kann.
    #[test]
    fn faehigkeit_verlangt_beides() {
        assert!(verfuegbar("amd", &["av1".to_string()]));
        assert!(!verfuegbar("amd", &["h264".to_string()]));
        // Aus einer gemischten Liste genügt ein tragender Codec.
        assert!(verfuegbar("amd", &["h264".to_string(), "av1".to_string()]));
    }

    /// Ungemessen heißt Nein. Der Test steht hier, damit ein späteres `true`
    /// für NVIDIA eine bewusste Änderung ist und nicht als Nebenwirkung
    /// hereinrutscht — zusammen mit der Messung, die es dann trägt.
    #[test]
    fn nvidia_und_intel_sind_hier_noch_nein() {
        assert!(!verfuegbar("nvidia", &["av1".to_string(), "h264".to_string()]));
        assert!(!verfuegbar("intel", &["av1".to_string(), "h264".to_string()]));
    }

    /// Der Gegenprobe-Schalter auf D3D12 nimmt H.264 vom AMF-Weg — und damit
    /// erst recht von HDR. Geprüft über denselben Namensauflöser, den der
    /// Start benutzt, statt über eine zweite Annahme darüber, was dort läuft.
    #[test]
    fn d3d12_gegenprobe_traegt_kein_hdr() {
        // `h264_d3d12va` ist der Name, den `encoder_name` unter dem Schalter
        // liefert; ohne den Schalter kommt man hier nicht hin. Direkt gegen die
        // Tabelle geprüft, weil der Schalter prozessweit ist.
        assert!(!traegt_hdr("h264_d3d12va"));
        assert!(!traegt_hdr("av1_d3d12va"));
        assert!(!traegt_hdr("av1_qsv"));
    }
}
