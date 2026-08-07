//! Die Auswertung: jeden Bildpunkt gegen den geschriebenen Wert halten — und,
//! wenn das schiefgeht, die Gegenrichtung als Trennschnitt.

use crate::bildformat::{chroma_codes, luma_code, BREITE, HOEHE};
use crate::{d3d11, rueckprobe};
use crate::Wahl;

/// Jeden Bildpunkt gegen den geschriebenen Wert pruefen.
///
/// Verglichen wird im ABTASTRAUM [0,1], nicht in Codewerten: nur so ist der
/// Vergleich fuer 8 und 10 Bit derselbe, und die Toleranz bleibt an das Format
/// gebunden statt an das Ziel.
pub fn auswerten(wahl: &Wahl, werte: &[f64], variante: u32) -> (usize, Option<String>) {
    let (u_soll, v_soll) = chroma_codes(wahl.format);
    // Ein Schritt Spielraum: die Abtastung laeuft ueber Gleitkomma-Normierung,
    // das letzte Bit darf wandern. Bei NV12 ist das exakt die alte Toleranz von
    // einem 8-Bit-Schritt — die Zahlen bleiben mit den frueheren Laeufen
    // vergleichbar.
    let toleranz = 1.0 / wahl.format.hoechster_code() as f64;
    let mut fehler = 0usize;
    let mut erstes: Option<String> = None;
    for y in 0..HOEHE {
        for x in 0..BREITE {
            let i = ((y * BREITE + x) * 3) as usize;
            let (r, g, b) = (werte[i], werte[i + 1], werte[i + 2]);
            let soll = (
                wahl.format.abtastwert(luma_code(wahl.format, x, y, wahl.schicht + variante)),
                wahl.format.abtastwert(u_soll),
                wahl.format.abtastwert(v_soll),
            );
            let ok = (r - soll.0).abs() <= toleranz
                && (g - soll.1).abs() <= toleranz
                && (b - soll.2).abs() <= toleranz;
            if !ok {
                fehler += 1;
                let code = |v: f64| (v * wahl.format.hoechster_code() as f64).round() as i32;
                erstes.get_or_insert_with(|| {
                    format!(
                        "({x},{y}): gelesen {}/{}/{}, erwartet {}/{}/{} (in Codewerten)",
                        code(r),
                        code(g),
                        code(b),
                        code(soll.0),
                        code(soll.1),
                        code(soll.2)
                    )
                });
            }
        }
    }
    (fehler, erstes)
}

/// Stufe 5: aus wgpu schreiben, mit D3D11 lesen.
///
/// Trennt die zwei moeglichen Ursachen eines schwarzen Ergebnisses: verworfener
/// Anfangsinhalt (dann sieht D3D11 die Aenderung) gegen falsch gebundenen
/// Speicher (dann sieht D3D11 nichts). Gibt `Some(code)` zurueck, wenn damit
/// ein eigenes Urteil feststeht.
pub fn gegenrichtung(
    wahl: &Wahl,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    textur: &wgpu::Texture,
    quelle: &d3d11::D3d11Quelle,
) -> Option<i32> {
    println!("\n== Stufe 5: Gegenrichtung — aus wgpu schreiben, mit D3D11 lesen ==");
    // Die Marke wird als GESPEICHERTES Wort geschrieben, nicht als Byte — bei
    // P010 sind das zwei Byte je Abtastwert. Der Code 0xA5 ist bei beiden
    // Formaten darstellbar (255 bzw. 1023 sind die Obergrenzen).
    const MARKE: u32 = 0xA5;
    let b = wahl.format.bytes();
    let wort = wahl.format.gespeichert(MARKE).to_le_bytes();
    let mut alle = Vec::with_capacity((BREITE * HOEHE) as usize * b);
    for _ in 0..(BREITE * HOEHE) as usize {
        alle.extend_from_slice(&wort[..b]);
    }
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: textur,
            mip_level: 0,
            // Die Schicht, die auch abgetastet wurde — sonst pruefte die
            // Gegenrichtung eine andere als Stufe 4.
            origin: wgpu::Origin3d { x: 0, y: 0, z: wahl.schicht },
            aspect: wgpu::TextureAspect::Plane0,
        },
        &alle,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(BREITE * b as u32),
            rows_per_image: Some(HOEHE),
        },
        wgpu::Extent3d { width: BREITE, height: HOEHE, depth_or_array_layers: 1 },
    );
    queue.submit([]);
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let erwartet_wort = u32::from(wahl.format.gespeichert(MARKE));
    match rueckprobe::luma_lesen(quelle, wahl.schicht, &|_, _| erwartet_wort) {
        Ok(0) => {
            println!("D3D11 sieht das aus wgpu Geschriebene: Speicher IST geteilt.");
            println!();
            println!("URTEIL: Handle, Import und Ebenen-Ansichten stimmen, und beide");
            println!("        Seiten arbeiten auf DEMSELBEN Speicher. Was fehlt, ist");
            println!("        allein die Erhaltung des vorhandenen Inhalts beim ersten");
            println!("        Zugriff.");
            Some(2)
        }
        Ok(n) => {
            println!("D3D11 sieht die Aenderung NICHT ({n} von {} Werten).", BREITE * HOEHE);
            println!();
            println!("URTEIL: Der Import bindet nicht den geteilten Speicher. Die");
            println!("        Ursache liegt frueher als jede Zustandsfrage.");
            Some(3)
        }
        Err(e) => {
            println!("Gegenrichtung nicht pruefbar: {e}");
            None
        }
    }
}
