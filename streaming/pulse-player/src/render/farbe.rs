//! Farb- und Formatentscheidungen — alles, was NUR vom Ausgabeformat und von
//! der Form der hochgeladenen Texturen abhaengt.
//!
//! Getrennt vom [`Renderer`](super::Renderer), weil der Messpfad
//! ([`crate::messen`]) genau diese Entscheidungen teilen muss, ohne ein
//! Fenster zu haben — und weil hier die Farbwissenschaft steht, die man beim
//! Lesen des Zeichenablaufs nicht sucht. Die Messgrundlage der Zahlen:
//! `docs/2026-08-04-player-farbwerte-messung.md`.

use crate::decode::{ColorMatrix, PixelLayout};
use crate::proto::PlayerOptions;
use crate::render::Uniforms;


/// Was der Uniform-Bau ueber das anliegende Bild wissen muss — der
/// beschreibende Teil von [`Planes`], ohne die Texturen selbst.
#[derive(Clone, Copy)]
pub struct Bildform {
    pub layout: PixelLayout,
    pub ten_bit: bool,
    /// Ob die TEXTUREN 16 bit tragen (nicht, ob die Quelle 10 bit hatte).
    pub wide: bool,
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
    matrix: ColorMatrix,
    zeit: f32,
) -> Uniforms {
    let zoom = opts.zoom.unwrap_or(1.0).max(1.0);
    let size = 1.0 / zoom;
    // Ausschnitt so verschieben, dass er im Bild bleibt.
    let origin_x = (opts.pan_x.unwrap_or(0.5) - size / 2.0).clamp(0.0, 1.0 - size);
    let origin_y = (opts.pan_y.unwrap_or(0.5) - size / 2.0).clamp(0.0, 1.0 - size);
    let flag = |on: bool| if on { 1.0 } else { 0.0 };
    let (abtast_skalierung, code_massstab) = scales(form.wide, form.layout);

    Uniforms {
        crop: [origin_x, origin_y, size, size],
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
            flag(matrix == ColorMatrix::Bt601),
            code_massstab,
            0.0,
        ],
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
