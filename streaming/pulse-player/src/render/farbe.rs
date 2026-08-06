//! Farb- und Formatentscheidungen — alles, was NUR vom Ausgabeformat und von
//! der Form der hochgeladenen Texturen abhaengt.
//!
//! Getrennt vom [`Renderer`](super::Renderer), weil der Messpfad
//! ([`crate::messen`]) genau diese Entscheidungen teilen muss, ohne ein
//! Fenster zu haben — und weil hier die Farbwissenschaft steht, die man beim
//! Lesen des Zeichenablaufs nicht sucht. Die Messgrundlage der Zahlen:
//! `docs/2026-08-04-player-farbwerte-messung.md`.

use crate::decode::{ColorMatrix, Farbangaben, PixelLayout, Uebertragung};
use crate::proto::PlayerOptions;
use crate::render::Uniforms;

/// Ersatz-Spitzenhelligkeit, wenn der Strom keine nennt (cd/m²).
///
/// **Eine geratene Zahl, und sie steht deshalb hier oben mit Namen** statt
/// irgendwo im Rechenweg. 1000 ist der Wert, auf den HDR10-Inhalte
/// ueblicherweise gemastert werden; er ist beim Herunterrechnen die
/// vorsichtige Wahl, weil ein zu HOHER Wert das Bild nur etwas dunkler macht,
/// ein zu niedriger dagegen Spitzlichter ausfressen laesst.
///
/// Unsere eigenen Stroeme nennen ihre Spitze (der Sidecar haengt sie an jedes
/// Bild) — dieser Wert greift also nur bei fremdem Material.
const ERSATZ_SPITZE_NITS: f32 = 1000.0;


/// Was der Uniform-Bau ueber das anliegende Bild wissen muss — der
/// beschreibende Teil von [`Planes`], ohne die Texturen selbst.
#[derive(Clone, Copy)]
pub struct Bildform {
    pub layout: PixelLayout,
    pub ten_bit: bool,
    /// Ob die TEXTUREN 16 bit tragen (nicht, ob die Quelle 10 bit hatte).
    pub wide: bool,
    /// Welcher Anteil der Textur ueberhaupt Bild ist, in x und y.
    ///
    /// **Normalerweise `[1.0, 1.0]`** — die hochgeladenen Ebenen sind exakt so
    /// gross wie das Bild. Auf dem Zero-Copy-Weg nicht: dort ist die Textur die
    /// des Decoders, und der rundet auf (bei AV1 auf Vielfache von 128, aus
    /// 1080 werden also 1152 Zeilen). Ohne diesen Faktor zeigte der Player die
    /// Fuellzeilen mit an — schwarze oder muellige Raender, die kein Fehler des
    /// Stroms waeren.
    pub nutzanteil: [f32; 2],
}

impl Bildform {
    /// Die uebliche Form: die Textur ist genau das Bild.
    pub fn voll(layout: PixelLayout, ten_bit: bool, wide: bool) -> Self {
        Self { layout, ten_bit, wide, nutzanteil: [1.0, 1.0] }
    }
}

/// Der Uniform-Block, aus dem der Shader alles liest.
///
/// Frei statt Methode, damit der Messpfad ([`crate::messen`]) ihn TEILT statt
/// ihn nachzubauen: welche Bedeutung in welchem Steckplatz sitzt, steht damit
/// an genau einer Stelle. Ein Nachbau hier waere die gefaehrlichste Doppelung
/// im Crate — ein vergessener Steckplatz macht die Messung still falsch, ohne
/// dass das Bild unplausibel wuerde.
pub fn build_uniforms(
    format: wgpu::TextureFormat,
    form: Bildform,
    opts: &PlayerOptions,
    full_range: bool,
    farbe: Farbangaben,
    // Kann das FENSTER HDR — also nimmt es lineares Licht ueber 1,0 an und
    // gibt es als solches aus? Nicht dasselbe wie `surface_is_linear`: eine
    // fp16-Oberflaeche in einer SDR-Sitzung ist linear, aber kein HDR-Fenster,
    // und wer beides verwechselt, bekommt ein um Faktor 80/203 zu dunkles Bild.
    // Entschieden wird das in `setup::hdr_fenster`.
    hdr_fenster: bool,
    zeit: f32,
) -> Uniforms {
    let zoom = opts.zoom.unwrap_or(1.0).max(1.0);
    let size = 1.0 / zoom;
    // Ausschnitt so verschieben, dass er im Bild bleibt.
    let origin_x = (opts.pan_x.unwrap_or(0.5) - size / 2.0).clamp(0.0, 1.0 - size);
    let origin_y = (opts.pan_y.unwrap_or(0.5) - size / 2.0).clamp(0.0, 1.0 - size);
    let flag = |on: bool| if on { 1.0 } else { 0.0 };
    let (abtast_skalierung, code_massstab) = scales(form.wide, form.layout);

    // Der Zoom-Ausschnitt liegt in Bild-Koordinaten, der Shader tastet aber die
    // TEXTUR ab. Traegt die Textur Fuellzeilen (Zero-Copy, s.
    // `Bildform::nutzanteil`), muss beides zusammen — sonst zoomte man in einen
    // Ausschnitt, der die Fuellung einschliesst.
    let [nx, ny] = form.nutzanteil;

    Uniforms {
        crop: [origin_x * nx, origin_y * ny, size * nx, size * ny],
        params: [
            opts.deband.unwrap_or(0.0),
            flag(opts.dither.unwrap_or(true)),
            output_levels(format),
            zeit,
        ],
        flags: [
            flag(form.ten_bit),
            flag(full_range),
            flag(form.layout == PixelLayout::BiPlanar420),
            abtast_skalierung,
        ],
        output: [
            flag(surface_is_linear(format)),
            matrix_kennzahl(farbe.matrix),
            code_massstab,
            0.0,
        ],
        hdr: [
            flag(farbe.uebertragung == Uebertragung::Pq),
            // **Ein HDR-Fenster nuetzt nur einer HDR-Quelle.** Bliebe die
            // Kennung bei einem SDR-Strom stehen, liefe er durch den PQ-Zweig
            // des Shaders — den er nie erreicht, weil `hdr.x` dann 0 ist. Die
            // Und-Verknuepfung hier ist trotzdem richtig und nicht doppelt
            // gemoppelt: sie haelt die beiden Kennungen widerspruchsfrei,
            // damit eine spaetere Auswertung von `hdr.y` allein nicht in die
            // Irre laeuft.
            flag(hdr_fenster && farbe.uebertragung == Uebertragung::Pq),
            farbe.spitze_nits.unwrap_or(ERSATZ_SPITZE_NITS),
            0.0,
        ],
    }
}

/// Welche YUV-Matrix der Shader nehmen soll, als Zahl.
///
/// **0 und 1 behalten ihre alte Bedeutung** (BT.709 bzw. BT.601). Das ist die
/// Bedingung dafuer, dass die Erweiterung auf drei Matrizen an den beiden
/// bestehenden Faellen nichts aendert — vorher stand an derselben Stelle ein
/// Ja/Nein („BT.601?").
fn matrix_kennzahl(matrix: ColorMatrix) -> f32 {
    match matrix {
        ColorMatrix::Bt709 => 0.0,
        ColorMatrix::Bt601 => 1.0,
        ColorMatrix::Bt2020Ncl => 2.0,
    }
}

/// Stufenzahl des Ausgabeformats (2^Bits pro Kanal) fuer das Dither.
///
/// Frei statt Methode, weil der Messpfad ([`crate::messen`]) dieselbe Antwort
/// braucht, ohne einen Renderer samt Fenster zu haben — und weil sie einzig
/// vom Format abhaengt, von nichts sonst.
pub fn output_levels(format: wgpu::TextureFormat) -> f32 {
    match format {
        // fp16 ist Fliesskomma: die Mantisse traegt nahe 1.0 rund 11 Bit, nicht
        // 16. Mit 65536 Stufen waere das Dither-Rauschen so schwach, dass es
        // das Banding der spaeteren Quantisierung durch den Compositor nicht
        // mehr aufbricht.
        wgpu::TextureFormat::Rgba16Float => 2048.0,
        wgpu::TextureFormat::Rgb10a2Unorm => 1024.0,
        _ => 256.0,
    }
}

/// Ob das Ausgabeformat LINEARE Werte erwartet.
///
/// Nicht Theorie, sondern gemessen (2026-07-26, KWin 6.7.3): derselbe Strom in
/// zwei Fenstern, einziger Unterschied das Format. Der `Bgra8Unorm`-Puffer sah
/// richtig aus, der `Rgba16Float`-Puffer flau — also deutet der Compositor
/// fp16 als lineares Licht (scRGB) und Unorm als sRGB-kodiert. Der Shader
/// rechnet in gamma-kodiertem R'G'B', weil das Video so vorliegt; fuer fp16
/// muss deshalb umgerechnet werden.
///
/// `*UnormSrgb` ist hier bewusst NICHT dabei: dort kodiert die Hardware beim
/// Schreiben selbst, eine zusaetzliche Umrechnung waere doppelt.
pub fn surface_is_linear(format: wgpu::TextureFormat) -> bool {
    matches!(format, wgpu::TextureFormat::Rgba16Float)
}

/// Faktor, mit dem ein als `*16Unorm` gelesener Abtastwert multipliziert
/// werden muss, um wieder in [0,1] zu liegen.
///
/// Der Unterschied ist leicht zu uebersehen und entscheidet ueber richtiges
/// gegen fast schwarzes Bild:
/// * `P010LE` (biplanar, kommt von NVDEC) legt die 10 Bit in die **oberen**
///   Bits eines 16-bit-Wortes. Als Unorm gelesen stimmt der Wert bereits.
/// * `YUV420P10LE` (planar, kommt von libdav1d/Software-Decode) legt sie in
///   die **unteren** Bits, Wertebereich 0..1023. Als Unorm gelesen waere das
///   um Faktor ~64 zu dunkel.
pub fn narrow_plane_into(source: &[u8], layout: PixelLayout, out: &mut Vec<u8>) {
    // Planar (YUV420P10LE) legt die 10 Bit in die UNTEREN Bits, Wertebereich
    // 0..1023 -> zwei Bit abschneiden. P010 legt sie in die OBEREN, dort ist
    // das hohe Byte schon der richtige 8-bit-Wert.
    let planar = layout == PixelLayout::Planar420;
    // `clear` behaelt die Kapazitaet — nach dem ersten Bild wird hier nichts
    // mehr angefordert.
    out.clear();
    out.reserve(source.len() / 2);
    out.extend(source.chunks_exact(2).map(|w| {
        let v = u16::from_le_bytes([w[0], w[1]]);
        if planar { (v >> 2) as u8 } else { (v >> 8) as u8 }
    }));
}

#[cfg(test)]
fn narrow_plane(source: &[u8], layout: PixelLayout) -> Vec<u8> {
    let mut out = Vec::new();
    narrow_plane_into(source, layout, &mut out);
    out
}

/// Faktor fuer die Abtastwerte, abhaengig davon, wie die Daten in der TEXTUR
/// liegen — NICHT davon, was die Quelle war.
///
/// `wide_texture` heisst: die Textur traegt 16 bit. Wurde eine 10-bit-Quelle
/// beim Hochladen auf 8 bit heruntergerechnet (GPU ohne
/// `TEXTURE_FORMAT_16BIT_NORM`), darf nicht skaliert werden — sonst waere das
/// Bild um Faktor 64 zu hell.
/// * `.0` = Faktor, mit dem ein als `*16Unorm` gelesener Abtastwert
///   multipliziert werden muss, um wieder in [0,1] zu liegen.
/// * `.1` = wieviele **8-bit-aequivalente Codewerte** danach auf 1.0 gehen —
///   der Massstab, mit dem der Shader Schwarzpunkt (16), Weisspunkt (235) und
///   Chroma-Nullpunkt (128) trifft.
///
/// **Bewusst EIN `match` fuer beide Zahlen.** Sie beantworten dieselbe Frage
/// ueber dieselben zwei Eingaben, und die drei Massstaebe liegen mit
/// 255 / 255,75 / 255,996 innerhalb von 0,4 % beieinander — zwei getrennte
/// Tabellen koennten auseinanderlaufen, ohne dass man es dem Bild ansaehe.
///
/// Warum der Massstab nicht einfach 255 sein darf: mit 255 gilt
/// „Schwarz = 16/255", und in 10 bit ist Schwarz 64/1023 = 0,062561, nicht
/// 0,062745. Der Fehler sitzt als Verstaerkungsfehler im ganzen Bild — am
/// Weisspunkt fehlten dadurch 3 von 1023 Stufen, und neutrales Chroma lag
/// einen halben Code daneben (Grau bekam einen Blaustich). Gemessen am
/// 2026-08-04 mit `pulse-player --stufen`,
/// `docs/2026-08-04-player-farbwerte-messung.md`.
/// Die Texturformate der beiden Ebenen — Luma und Chroma.
///
/// **Steht hier und nicht bei den Aufrufern, weil [`scales`] direkt darunter
/// mit GENAU dieser Zuordnung rechnet.** Bis zum 2026-08-06 gab es die Tabelle
/// dreimal (`render::bildquelle`, `render::fremdbild`, `messen::gpu`), und
/// `scales` traegt seit jeher die Begruendung, warum das nicht sein darf:
/// „zwei getrennte Tabellen koennten auseinanderlaufen, ohne dass man es dem
/// Bild ansaehe". Ein Auseinanderlaufen hier ist ein Verstaerkungsfehler ueber
/// das ganze Bild, kein sichtbarer Fehler.
///
/// `wide` heisst — wie bei [`scales`] — dass die TEXTUR 16 bit traegt, nicht
/// dass die Quelle 10 bit hatte.
pub fn ebenenformate(
    wide: bool,
    layout: PixelLayout,
) -> (wgpu::TextureFormat, wgpu::TextureFormat) {
    let einzeln =
        if wide { wgpu::TextureFormat::R16Unorm } else { wgpu::TextureFormat::R8Unorm };
    let chroma = match layout {
        // Planar: die Chroma-Ebenen sind einkanalig wie Luma.
        PixelLayout::Planar420 => einzeln,
        PixelLayout::BiPlanar420 if wide => wgpu::TextureFormat::Rg16Unorm,
        PixelLayout::BiPlanar420 => wgpu::TextureFormat::Rg8Unorm,
    };
    (einzeln, chroma)
}

pub fn scales(wide_texture: bool, layout: PixelLayout) -> (f32, f32) {
    match (wide_texture, layout) {
        // 8-bit-Textur (auch heruntergerechnetes 10 bit): Abtastwert = Code/255.
        (false, _) => (1.0, 255.0),
        // Planar 10 bit: Werte 0..1023 in den UNTEREN Bits — hochskalieren auf
        // Code/1023; ein 8-bit-Code ist ein Viertel davon.
        (true, PixelLayout::Planar420) => (f32::from(u16::MAX) / 1023.0, 1023.0 / 4.0),
        // P010: die zehn Bit sitzen OBEN, der Wert stimmt bereits.
        (true, _) => (1.0, f32::from(u16::MAX) / 256.0),
    }
}

#[cfg(test)]
mod hdr_tests {
    use super::*;

    /// **Der Zero-Copy-Fall.** Traegt die Textur Fuellzeilen des Decoders
    /// (`nutzanteil < 1`), muss der Ausschnitt entsprechend schrumpfen — sonst
    /// zeigte der Player die Fuellung mit. Und der Zoom muss dabei
    /// mitmultipliziert werden, nicht neben dem Faktor stehen: sonst zoomte man
    /// in einen Ausschnitt, der die Fuellung wieder einschliesst.
    #[test]
    fn fuellzeilen_verkleinern_den_ausschnitt() {
        let form = |anteil: [f32; 2]| Bildform {
            layout: PixelLayout::BiPlanar420,
            ten_bit: true,
            wide: true,
            nutzanteil: anteil,
        };
        let bauen = |f: Bildform, zoom: Option<f32>| {
            build_uniforms(
                wgpu::TextureFormat::Rgb10a2Unorm,
                f,
                &PlayerOptions { zoom, ..PlayerOptions::default() },
                false,
                Farbangaben::default(),
                false,
                0.0,
            )
        };
        // Volle Textur, kein Zoom: der ganze Bereich.
        let voll = bauen(form([1.0, 1.0]), None);
        assert_eq!(voll.crop, [0.0, 0.0, 1.0, 1.0]);

        // 1080 Bildzeilen in einer auf 1152 aufgerundeten Textur.
        let anteil = 1080.0f32 / 1152.0;
        let beschnitten = bauen(form([1.0, anteil]), None);
        assert_eq!(beschnitten.crop[3], anteil, "Hoehe muss auf den Nutzanteil");
        assert_eq!(beschnitten.crop[2], 1.0, "Breite bleibt voll");

        // Mit Zoom 2: beides zusammen, nicht nur eines von beiden.
        let gezoomt = bauen(form([1.0, anteil]), Some(2.0));
        assert!(
            (gezoomt.crop[3] - 0.5 * anteil).abs() < 1e-6,
            "Zoom und Nutzanteil muessen sich multiplizieren: {}",
            gezoomt.crop[3]
        );
        assert!(
            (gezoomt.crop[1] - 0.25 * anteil).abs() < 1e-6,
            "auch der Ursprung: {}",
            gezoomt.crop[1]
        );
    }

    fn bau(farbe: Farbangaben, hdr_fenster: bool, format: wgpu::TextureFormat) -> crate::render::Uniforms {
        build_uniforms(
            format,
            Bildform::voll(PixelLayout::BiPlanar420, true, true),
            &PlayerOptions::default(),
            false,
            farbe,
            hdr_fenster,
            0.0,
        )
    }

    fn pq(spitze: Option<f32>) -> Farbangaben {
        Farbangaben {
            matrix: ColorMatrix::Bt2020Ncl,
            uebertragung: Uebertragung::Pq,
            weiter_farbraum: true,
            spitze_nits: spitze,
        }
    }

    /// **Ein SDR-Strom muss exakt den alten Weg nehmen.** Beide HDR-Kennungen
    /// null, Matrix-Kennzahl 0 fuer BT.709 und 1 fuer BT.601 — genau die
    /// Bedeutung, die die Stelle vor der Umstellung auf drei Matrizen hatte.
    /// Waere das nicht so, haette die HDR-Arbeit nebenbei jedes bestehende Bild
    /// veraendert.
    #[test]
    fn sdr_bleibt_unveraendert() {
        let u = bau(Farbangaben::default(), false, wgpu::TextureFormat::Rgb10a2Unorm);
        assert_eq!(u.hdr[0], 0.0, "Quelle ist nicht PQ");
        assert_eq!(u.hdr[1], 0.0, "kein HDR-Fenster");
        assert_eq!(u.output[1], 0.0, "BT.709");

        let bt601 = Farbangaben { matrix: ColorMatrix::Bt601, ..Default::default() };
        assert_eq!(bau(bt601, false, wgpu::TextureFormat::Rgb10a2Unorm).output[1], 1.0);
    }

    #[test]
    fn hdr_quelle_setzt_kurve_matrix_und_spitze() {
        let u = bau(pq(Some(600.0)), true, wgpu::TextureFormat::Rgba16Float);
        assert_eq!(u.hdr[0], 1.0, "PQ-Kurve");
        assert_eq!(u.hdr[1], 1.0, "HDR-Fenster");
        assert_eq!(u.hdr[2], 600.0, "Spitze aus dem Strom");
        assert_eq!(u.output[1], 2.0, "BT.2020 NCL");
    }

    /// Sagt der Strom nichts ueber seine Spitzenhelligkeit, muss der
    /// Ersatzwert stehen — und zwar ein benannter, kein im Rechenweg
    /// versteckter.
    #[test]
    fn ohne_angabe_greift_der_ersatzwert() {
        assert_eq!(bau(pq(None), false, wgpu::TextureFormat::Rgb10a2Unorm).hdr[2], ERSATZ_SPITZE_NITS);
    }

    /// **Ein HDR-Fenster ohne HDR-Quelle darf nicht als solches gelten.**
    /// Sonst liefe ein SDR-Strom mit der Kennung „lineares Licht" — und wenn
    /// spaeter jemand `hdr.y` allein auswertet, bekommt er ein um mehr als das
    /// Doppelte zu dunkles Bild, ohne dass die Ursache hier zu sehen waere.
    #[test]
    fn hdr_fenster_ohne_hdr_quelle_zaehlt_nicht() {
        let u = bau(Farbangaben::default(), true, wgpu::TextureFormat::Rgba16Float);
        assert_eq!(u.hdr[1], 0.0);
    }
}

#[cfg(test)]
mod scale_tests {
    use super::*;

    #[test]
    fn heruntergerechnete_planes_werden_nicht_skaliert() {
        // Ohne 16-bit-Texturen liegen die Daten als 8 bit in der Textur —
        // dann waere jede Skalierung falsch.
        assert!((scales(false, PixelLayout::Planar420).0 - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn narrow_plane_rechnet_je_layout_richtig_herunter() {
        // Planar: Werte in den unteren Bits, 0..1023 -> zwei Bit abschneiden.
        let planar = narrow_plane(&[0x00, 0x01, 0xFF, 0x03], PixelLayout::Planar420);
        assert_eq!(planar, vec![(0x0100u16 >> 2) as u8, (0x03FFu16 >> 2) as u8]);
        // P010: Werte in den oberen Bits -> hohes Byte ist der 8-bit-Wert.
        let p010 = narrow_plane(&[0x00, 0x40, 0x00, 0xFF], PixelLayout::BiPlanar420);
        assert_eq!(p010, vec![0x40, 0xFF]);
    }

    #[test]
    fn zehn_bit_planar_wird_hochskaliert_biplanar_nicht() {
        // YUV420P10LE: Werte 0..1023 in den unteren Bits -> muss skaliert werden.
        let planar = scales(true, PixelLayout::Planar420).0;
        assert!((planar - 65535.0 / 1023.0).abs() < 0.01, "planar: {planar}");
        // P010LE: Werte liegen bereits in den oberen Bits -> unveraendert.
        assert!((scales(true, PixelLayout::BiPlanar420).0 - 1.0).abs() < f32::EPSILON);
    }

    /// Der Massstab muss zu dem passen, was die Abtast-Skalierung hinterlaesst:
    /// Schwarz (Code 16 bzw. 64) muss auf 16 fallen, Weiss (235 bzw. 940) auf
    /// 235. Sitzt er daneben, bleibt das Bild plausibel — es ist nur zu flau
    /// oder zu kontrastreich, und niemand sieht die Ursache.
    #[test]
    fn massstab_trifft_schwarz_und_weiss_in_jeder_bittiefe() {
        // (wide, layout, Rohwert des Samplers fuer Schwarz und fuer Weiss)
        for (wide, layout, schwarz, weiss) in [
            (false, PixelLayout::Planar420, 16.0 / 255.0, 235.0 / 255.0),
            (false, PixelLayout::BiPlanar420, 16.0 / 255.0, 235.0 / 255.0),
            (true, PixelLayout::Planar420, 64.0 / 65535.0, 940.0 / 65535.0),
            // P010 legt die zehn Bit in die OBEREN Bits: Code 64 steht als 64<<6.
            (true, PixelLayout::BiPlanar420, (64.0 * 64.0) / 65535.0, (940.0 * 64.0) / 65535.0),
        ] {
            let (skalierung, k) = scales(wide, layout);
            let code = |roh: f32| roh * skalierung * k;
            assert!((code(schwarz) - 16.0).abs() < 1e-2, "{layout:?} wide={wide} Schwarz: {}", code(schwarz));
            assert!((code(weiss) - 235.0).abs() < 1e-2, "{layout:?} wide={wide} Weiss: {}", code(weiss));
        }
    }

    /// Neutrales Chroma muss auf 0 abbilden — in JEDER Bittiefe. Genau das war
    /// bis 2026-08-04 falsch (der Shader zog 0.5 ab statt 128/Massstab), und
    /// Grau bekam dadurch einen Blaustich.
    #[test]
    fn neutrales_chroma_faellt_auf_null() {
        for (wide, layout, roh) in [
            (false, PixelLayout::Planar420, 128.0 / 255.0),
            (false, PixelLayout::BiPlanar420, 128.0 / 255.0),
            (true, PixelLayout::Planar420, 512.0 / 65535.0),
            (true, PixelLayout::BiPlanar420, (512.0 * 64.0) / 65535.0),
        ] {
            let (skalierung, k) = scales(wide, layout);
            let s: f32 = roh * skalierung;
            assert!((s - 128.0 / k).abs() < 1e-5, "{layout:?} wide={wide}: {s} vs {}", 128.0 / k);
        }
    }
}
