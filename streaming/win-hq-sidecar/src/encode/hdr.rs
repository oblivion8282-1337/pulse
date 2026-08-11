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
//! nachgesehen (`docs/2026-08-06-hdr-windows-amd.md` für AMD,
//! `docs/2026-08-11-hdr-windows-nvidia.md` für NVIDIA).
//!
//! **Die Nutzlasten selbst stehen nicht hier, sondern in
//! [`super::hdr_metadaten`]** (abgetrennt am 2026-08-11 wegen der
//! Größen-Policy). Der Schnitt liegt an der ohnehin vorhandenen Naht: hier
//! steht, WER HDR trägt und was in den Sequenzkopf geht; dort, welche
//! Mastering-Angaben mitgehen und an welche der zwei Stellen sie müssen.

use anyhow::{Result, bail};
use ffmpeg_next as ffmpeg;

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
        // **Der zweite belegte Weg** (2026-08-11, RTX 5080, Treiber 610.47 =
        // 32.0.16.1047). `av1_nvenc` schreibt die Farb-Signalisierung
        // vollständig in den AV1-Sequenzkopf — am Bitstrom nachgesehen, nicht
        // an einer Optionstabelle: `transfer_characteristics = 16` (PQ),
        // `color_primaries = 9` und `matrix_coefficients = 9` (BT.2020),
        // `color_range = 0`, `high_bitdepth = 1`. Und der Inhalt ist echtes PQ,
        // nicht bloß so beschriftet (Messakte
        // `testbench/profiles/nvidia-2026-08-11-windows-hdr.json`).
        //
        // **Hier stand bis zum 2026-08-11 „ungemessen, nicht ausgeschlossen".**
        // Das ist eingelöst — mit einer benannten Einschränkung, die die alte
        // Zeile nicht vorhergesehen hat: **die HDR10-Mastering-Angaben kommen
        // NICHT im Strom an.** Kein einziges `OBU_METADATA` (Typ 5), auf der
        // ganzen Datei ausgezählt. Woran es liegt, ist eingegrenzt und liegt
        // nicht bei uns: derselbe Quellstrom, dasselbe FFmpeg und dieselbe
        // Codestelle (`nvenc_set_mastering_display_data`) schreiben über
        // `hevc_nvenc` beide SEI-Nachrichten anstandslos, über `av1_nvenc`
        // nichts. Der Weg dorthin ist trotzdem gebaut, weil er sonst auch nach
        // einem Treiber-Update nicht ginge — s. `hdr_metadaten::am_kontext`.
        //
        // **Warum das trotzdem `true` ist.** Die Tabelle fragt, ob der Encoder
        // eine HDR-**Signalisierung** bis in den Strom trägt, und die ist
        // vollständig. Der Fehler, gegen den es dieses Modul gibt, ist der
        // Strom, der HDR behauptet und SDR enthält; das ist hier nicht der
        // Fall. Was fehlt, sind Hinweise fürs Tone-Mapping des Zuschauers —
        // dieselbe Klasse von Mangel, mit der AV1 über AMF seit dem 2026-08-06
        // ausgeliefert wird (dort sind die Zahlen da, aber falsch skaliert).
        // Damit niemand ihn beim Zuschauer sucht, sagt [`mastering_fehlt`] ihn
        // beim Start an.
        "av1_nvenc" => true,
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
        // * `h264_nvenc`/`hevc_nvenc` — dieselbe Produktentscheidung wie bei
        //   AMD: 10 bit lässt `VideoCodec::supports_ten_bit` nur bei AV1 durch.
        //   Für HEVC ist beiläufig belegt, dass NVENC die Mastering-SEI
        //   schreibt (s. `av1_nvenc` oben) — das ändert an der Entscheidung
        //   nichts, HEVC wird ausgebaut.
        _ => false,
    }
}

/// Trägt dieser Encoder zwar die Signalisierung, aber **nicht** die
/// Mastering-Hinweise? Dann sagt er es beim Start — sonst sucht der Nächste den
/// Fehler beim Zuschauer.
///
/// Die Unterscheidung ist keine Spitzfindigkeit: ohne `MaxCLL` nimmt der eigene
/// Player 1000 cd/m² an (`render/farbe.rs::ERSATZ_SPITZE_NITS`), während dieser
/// Schirm 530 meldet. Auf einem SDR-Fenster rechnet er das Bild damit stärker
/// herunter als nötig — ein Bild, das „irgendwie flau" aussieht, ohne dass
/// irgendwo etwas fehlschlägt.
fn mastering_fehlt(encoder: &str) -> Option<&'static str> {
    (encoder == "av1_nvenc").then_some(
        "NVENC schreibt auf diesem Treiber keine HDR10-Mastering-Angaben in den AV1-Strom \
         (gemessen 2026-08-11, docs/2026-08-11-hdr-windows-nvidia.md). Die Farb-Signalisierung \
         ist vollständig; Zuschauer ohne MaxCLL nehmen einen Ersatzwert fürs Tone-Mapping.",
    )
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
        codec.supports_ten_bit() && encoder_name(vendor, codec, "").is_some_and(traegt_hdr)
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
             AV1 über AMF (AMD) und AV1 über NVENC (NVIDIA). \
             Begründung je Encoder: encode/hdr.rs"
        );
    }
    if let Some(fehlt) = mastering_fehlt(encoder) {
        eprintln!("[hdr] {fehlt}");
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
    // **Vor dem Öffnen, nicht danach** — NVENC entscheidet beim Öffnen ein für
    // alle Mal, ob es die Metadaten überhaupt schreibt. Begründung dort.
    super::hdr_metadaten::am_kontext(encoder, schirm);
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

#[cfg(test)]
mod tests {
    use super::*;

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

    /// **Hier stand bis zum 2026-08-11 `nvidia_und_intel_sind_hier_noch_nein`**
    /// — „ungemessen heißt Nein", damit ein späteres `true` für NVIDIA eine
    /// bewusste Änderung ist. Die Messung ist gefahren, die Änderung ist
    /// bewusst, der Test dreht sich um: **auf NVIDIA trägt AV1 HDR, H.264
    /// nicht** (10 bit lässt `supports_ten_bit` nur bei AV1 durch).
    ///
    /// Intel bleibt Nein und aus einem anderen Grund als „ungemessen": der Weg
    /// dorthin führt über die CPU-Pipeline, die BGRA entgegennimmt und gar
    /// keinen Farbwandler hat.
    #[test]
    fn auf_nvidia_traegt_nur_av1_hdr_intel_nichts() {
        assert!(verfuegbar("nvidia", &["av1".to_string()]));
        assert!(!verfuegbar("nvidia", &["h264".to_string()]));
        assert!(!verfuegbar("intel", &["av1".to_string(), "h264".to_string()]));
    }

    /// **Die Lücke muss angesagt werden, nicht nur dokumentiert.** Ein Strom,
    /// dem die Mastering-Hinweise fehlen, sieht beim Zuschauer flau aus, ohne
    /// dass irgendwo etwas fehlschlägt — genau dann sucht jemand tagelang am
    /// Player. Der Test hält fest, dass die Meldung an den Encoder gebunden
    /// ist, der sie betrifft, und nicht an den Hersteller.
    #[test]
    fn nur_nvenc_meldet_die_fehlenden_mastering_angaben() {
        assert!(mastering_fehlt("av1_nvenc").is_some());
        assert!(mastering_fehlt("av1_amf").is_none());
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
