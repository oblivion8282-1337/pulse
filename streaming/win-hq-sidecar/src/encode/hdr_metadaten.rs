//! Die HDR10-Nutzlasten — und die zwei Stellen, an die sie müssen.
//!
//! Abgetrennt von [`super::hdr`] am 2026-08-11, als der NVIDIA-Weg dazukam und
//! die Datei über die Größen-Grenze wuchs. Der Schnitt liegt an der Naht, die
//! ohnehin da war: **`hdr.rs` beantwortet, WER HDR trägt und was im
//! Sequenzkopf steht; hier steht, WAS an Mastering-Angaben mitgeht und wohin.**
//!
//! Und „wohin" ist der ganze Grund für dieses Modul: es sind **zwei** Stellen,
//! je Hersteller eine andere, und beide werden gebraucht.
//!
//! | | liest die Angaben aus | |
//! |---|---|---|
//! | `amfenc` (AMD) | dem **Bild** ([`am_bild`]) | kennt `decoded_side_data` nicht |
//! | `nvenc` (NVIDIA) | dem **Kontext** ([`am_kontext`]) für den Schalter, dann dem Bild für die Zahlen | ohne den Schalter wird das Bild nie gelesen |
//!
//! Wer eine der beiden Stellen wegnimmt, bricht genau einen Hersteller — und
//! zwar lautlos, denn nichts daran schlägt fehl.

use anyhow::{Result, bail};
use ffmpeg_next as ffmpeg;
use ffmpeg_next::ffi::{
    AVFrame, AVFrameSideDataType, AVRational, av_frame_new_side_data, av_frame_remove_side_data,
    av_frame_side_data_new,
};

use crate::system::hdr::SchirmFarbe;

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
///
/// **Für `nvenc.c` ist die Wahl gleichgültig, und das ist kein Zufall**: es
/// rechnet mit `av_rescale(num, ziel_nenner, den)`, nimmt den Bruch also als
/// Bruch. Es setzt dabei die Nenner ein, die AV1 selbst vorschreibt (1<<16 für
/// Farborte, 1<<8 bzw. 1<<14 für die Leuchtdichten) — genau die Umrechnung, die
/// AMF nach Befund 3 in `docs/2026-08-06-hdr-windows-amd.md` **nicht** macht.
/// Auf NVIDIA stehen die Mastering-Zahlen im Strom deshalb richtig, auf AMD
/// nicht.
const NENNER_FARBORT: i32 = 50_000;
const NENNER_LEUCHTDICHTE: i32 = 10_000;

/// Die beiden HDR10-Nutzlasten aus den Angaben des Schirms.
///
/// Einmal gebaut, an zwei Stellen gebraucht: am **Bild** (für AMF) und am
/// **Encoder-Kontext** (für NVENC). Zwei Fassungen davon liefen genau so
/// auseinander, wie es dieses Modul an anderer Stelle schon beschreibt.
fn nutzlasten(schirm: &SchirmFarbe) -> (AVMasteringDisplayMetadata, AVContentLightMetadata) {
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
    // Was wirklich im Bild vorkommt, wissen wir nicht — der Schirm ist die
    // obere Schranke, und eine wahre obere Schranke ist besser als eine
    // geratene genaue Zahl (Begründung ausführlich in
    // `farbraum::hdr10_metadaten`).
    let licht = AVContentLightMetadata {
        MaxCLL: schirm.max_nits as u32,
        MaxFALL: schirm.max_vollbild_nits as u32,
    };
    (display, licht)
}

/// Dieselben Angaben am **Encoder-Kontext**, vor dem Öffnen — und ohne sie
/// schreibt NVENC überhaupt keine HDR10-Metadaten.
///
/// **Das ist der Befund vom 2026-08-11**, gemessen an einem Datei-Mitschnitt
/// von `av1_nvenc` (RTX 5080): Signalisierung im Sequenzkopf einwandfrei
/// (`transfer_characteristics = 16`, `color_primaries = 9`,
/// `matrix_coefficients = 9`), aber **kein einziges OBU vom Typ 5**
/// (`OBU_METADATA`) im ganzen Strom — obwohl [`am_bild`] die
/// Begleitdaten an jedes Bild hängte.
///
/// Die Ursache steht in `libavcodec/nvenc.c`, `nvenc_setup_av1_config`:
///
/// ```c
/// ctx->mdm = av1->outputMasteringDisplay = !!av_frame_side_data_get(
///     avctx->decoded_side_data, avctx->nb_decoded_side_data,
///     AV_FRAME_DATA_MASTERING_DISPLAY_METADATA);
/// ```
///
/// NVENC bekommt den Schalter „schreib die Metadaten" **einmal beim Öffnen**,
/// und woran FFmpeg ihn festmacht, ist ausschließlich `decoded_side_data` — die
/// Begleitdaten am **Kontext**, nicht die am Bild. Ist er aus, überspringt
/// `nvenc_set_mastering_display_data` den Bild-Weg vollständig
/// (`if (ctx->mdm || ctx->cll)`), und die Werte, die wir je Bild anhängen,
/// werden nie gelesen. **Nichts daran schlägt fehl und nichts wird geloggt** —
/// dieselbe Klasse von stillem Verlust, gegen die es dieses Modul gibt.
///
/// **Beide Wege bleiben nötig, und keiner ersetzt den anderen.** NVENC liest
/// hieraus nur den Schalter und nimmt die Zahlen anschließend vom Bild;
/// `amfenc` kennt `decoded_side_data` gar nicht (nachgesehen: kommt in
/// `amfenc*.c` nicht vor) und liest ausschließlich das Bild. Deshalb steht das
/// hier zusätzlich zu [`am_bild`] und nicht an seiner Stelle — und
/// deshalb ist es für AMD folgenlos.
///
/// Der Fehlschlag ist bewusst **nicht** tödlich: er kostet die
/// Mastering-Hinweise, nicht die Bilddeutung (die steht im Sequenzkopf).
pub fn am_kontext(encoder: &mut ffmpeg::encoder::video::Video, schirm: &SchirmFarbe) {
    let (display, licht) = nutzlasten(schirm);
    // SAFETY: der Kontext gehört uns und ist noch nicht geöffnet;
    // `av_frame_side_data_new` legt den Eintrag im Array des Kontexts an,
    // `avcodec_close` gibt ihn wieder frei (`avcodec.c`, `av_frame_side_data_free`).
    let ok = unsafe {
        let ctx = encoder.as_mut_ptr();
        kontext_seitendaten(
            &raw mut (*ctx).decoded_side_data,
            &raw mut (*ctx).nb_decoded_side_data,
            AVFrameSideDataType::AV_FRAME_DATA_MASTERING_DISPLAY_METADATA,
            &display,
        ) && kontext_seitendaten(
            &raw mut (*ctx).decoded_side_data,
            &raw mut (*ctx).nb_decoded_side_data,
            AVFrameSideDataType::AV_FRAME_DATA_CONTENT_LIGHT_LEVEL,
            &licht,
        )
    };
    if !ok {
        eprintln!(
            "[encode] HDR-Mastering-Angaben nicht am Encoder-Kontext hinterlegt (kein Speicher). \
             Der Strom bleibt HDR — auf NVIDIA fehlen ihm dann die Hinweise fürs Tone-Mapping."
        );
    }
}

/// # Safety
///
/// `sd`/`nb_sd` müssen auf das Begleitdaten-Array eines lebenden, noch nicht
/// geöffneten `AVCodecContext` zeigen; `T` muss die Form haben, die FFmpeg
/// unter `art` erwartet.
unsafe fn kontext_seitendaten<T>(
    sd: *mut *mut *mut ffmpeg::ffi::AVFrameSideData,
    nb_sd: *mut std::os::raw::c_int,
    art: AVFrameSideDataType,
    wert: &T,
) -> bool {
    let groesse = std::mem::size_of::<T>();
    // `AV_FRAME_SIDE_DATA_FLAG_REPLACE` (2): der Encoder wird je Stream einmal
    // geöffnet, aber ein doppelter Eintrag wäre hier so wenig gewollt wie am
    // Bild (s. `seitendaten_schreiben`) — und die Flagge kostet nichts.
    let neu = unsafe { av_frame_side_data_new(sd, nb_sd, art, groesse, 2) };
    if neu.is_null() {
        return false;
    }
    unsafe {
        std::ptr::copy_nonoverlapping(std::ptr::from_ref(wert).cast::<u8>(), (*neu).data, groesse)
    };
    true
}

/// Einem Bild die HDR10-Metadaten anhängen, die AMF in den Strom schreibt.
///
/// **Warum je Bild und nicht einmal.** FFmpegs AMF-Zweig liest sie aus den
/// Begleitdaten des Bildes (`amf_save_hdr_metadata`), und zwar bei jedem
/// Einschieben; er kennt keinen Weg, sie einmal zu hinterlegen. Bei einem
/// Vollbild-Abstand von 60 s ist das sogar der bessere Weg: statische
/// Metadaten wiederholen sich üblicherweise an den Vollbildern, und die kommen
/// hier selten genug, dass ein später dazukommender Zuschauer lange warten
/// müsste.
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
pub unsafe fn am_bild(frame: *mut AVFrame, schirm: &SchirmFarbe) -> Result<()> {
    unsafe {
        (*frame).color_trc = ffmpeg::ffi::AVColorTransferCharacteristic::AVCOL_TRC_SMPTE2084;
        (*frame).colorspace = ffmpeg::ffi::AVColorSpace::AVCOL_SPC_BT2020_NCL;
        (*frame).color_primaries = ffmpeg::ffi::AVColorPrimaries::AVCOL_PRI_BT2020;
        (*frame).color_range = ffmpeg::ffi::AVColorRange::AVCOL_RANGE_MPEG;

        let (display, licht) = nutzlasten(schirm);
        seitendaten_schreiben(
            frame,
            AVFrameSideDataType::AV_FRAME_DATA_MASTERING_DISPLAY_METADATA,
            &display,
        )?;
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
/// Wie [`am_bild`]; `T` muss die Form haben, die FFmpeg unter
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
    unsafe {
        std::ptr::copy_nonoverlapping(std::ptr::from_ref(wert).cast::<u8>(), (*sd).data, groesse)
    };
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
                am_bild(frame, &s).expect("Begleitdaten anhängen");
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
}
