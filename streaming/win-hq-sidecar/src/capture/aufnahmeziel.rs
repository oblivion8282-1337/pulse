//! **Was der Aufnahme-Rückruf mit dem WGC-Bild macht** — kopieren oder gleich
//! umrechnen.
//!
//! ## Warum es diese Wahl gibt
//!
//! Die WGC-Textur gilt nur innerhalb des Rückrufs; der Taktfaden holt sie
//! später ab. Irgendetwas muss das Bild also in eine eigene Textur bringen.
//! Bis zum 2026-08-07 war das immer eine **Kopie**, und die Farbwandlung nach
//! P010 lief danach auf dem Taktfaden — also **zwei** Anfassen je Bild.
//! Gemessen (`streaming/testbench/profiles/leistung-2026-08-06-fp16-kopie-gemessen.json`):
//! 1,82 ms für die Kopie, 1,79 ms für den Shader, beide auf der 3D-Einheit.
//!
//! Der Shader liest die Quelle ohnehin. Er kann sie genauso gut **hier** lesen
//! und direkt nach P010 schreiben — dann entfällt die Kopie ganz, und der Pool
//! führt P010 (6,2 statt 29,5 MB je Textur bei 1440p). Gerechnet aus den
//! gemessenen Millisekunden sind das rund 109 ms je Sekunde, etwa die Hälfte
//! der 3D-Last des Senders.
//!
//! ## Was daran heikel ist
//!
//! Der Shader läuft dann auf dem **WGC-Rückruf-Faden**. Bleibt er dort zu
//! lange, verwirft WGC Bilder, und das meldet WGC nicht. Deshalb gibt es
//! [`super::rueckruf`] — die Wacht, die aus der Verweildauer eine **Obergrenze**
//! des möglichen Verlusts macht. Sie ist Vorbedingung dieses Weges, nicht
//! Beiwerk.
//!
//! ## Und warum nur HDR
//!
//! Die Kopie fällt für **jede** Aufnahme an, in SDR gemessen 0,96 ms. Der
//! SDR-Weg wandelt aber über den **Video-Prozessor** ([`crate::encode::d3d11_scale`]),
//! nicht über diesen Shader — das ist eine andere Sache mit eigener
//! Vorgeschichte, und sie hier mitzunehmen hieße, zwei Umbauten in einer
//! Messung zu vermengen. SDR bleibt deshalb unangetastet.

use anyhow::{Result, anyhow};
use ffmpeg_next::ffi::AVPixelFormat;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
};
use windows::core::Interface;

use crate::encode::hdr_zeichner::HdrZeichner;
use crate::encode::{HwContext, HwPoolConfig, OwnedHwFrame};

/// Wohin und wie das aufgenommene Bild geschrieben wird.
pub(super) enum Aufnahmeziel {
    /// Unverändert in eine Pool-Textur desselben Formats.
    Kopie,
    /// Direkt nach P010, in Zielmaßen — die Zwischenkopie entfällt.
    Wandlung(HdrZeichner),
}

/// Der Pool und das, was hineinschreibt. Beide entstehen beim ersten Bild und
/// gehören zusammen: das Pool-Format folgt der Wahl, nicht umgekehrt.
pub(super) struct ZielAufbau {
    pub hw: HwContext,
    pub ziel: Aufnahmeziel,
}

/// Pool und Schreibweg aufbauen.
///
/// `direkt_ziel` = `Some((w, h))` schaltet die Wandlung im Rückruf ein; die
/// Entscheidung darüber fällt **nicht hier**, sondern in
/// `pipeline_hw::vorstufe::direktwandlung`.
pub(super) fn bauen(
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    breite: u32,
    hoehe: u32,
    pool_size: u32,
    hdr: bool,
    direkt_ziel: Option<(u32, u32)>,
) -> Result<ZielAufbau> {
    let Some((dst_w, dst_h)) = direkt_ziel else {
        // **Das Pool-Format MUSS zu `ColorFormat` passen**, sonst kopiert
        // `CopySubresourceRegion` zwischen unterschiedlichen Formaten und wird
        // im Release-Build zum wortlosen No-Op: der Stream liefe mit schwarzen
        // Bildern, ohne dass irgendwo ein Fehler stünde. Die beiden Werte
        // stehen deshalb in `bildformat()` beieinander statt an zwei Stellen.
        let hw = HwContext::new(
            device.clone(),
            context.clone(),
            breite,
            hoehe,
            HwPoolConfig {
                pool_size,
                sw_format: super::bildformat(hdr).1,
                // **Im HDR-Fall die Bindungen selbst setzen.** libavutils
                // Vorgabe ist `DECODER|SHADER_RESOURCE`, und `DECODER` ist für
                // Decoder-Ausgabeflächen gedacht (NV12/P010) — auf einer
                // 16-Bit-Fließkomma-Textur lässt der Treiber danach keine
                // Shader-Ansicht mehr zu (`CreateShaderResourceView` scheitert
                // mit `E_INVALIDARG`, gemessen 2026-08-06). Der eigene
                // Farbwandler braucht aber genau diese Ansicht.
                //
                // Auf dem 8-Bit-Weg bleibt es bei der Vorgabe: dort liest kein
                // Shader, sondern der Video-Prozessor, und der will `DECODER`
                // sehen.
                extra_bind_flags: if hdr { 0x8 } else { 0 },
                ..Default::default()
            },
        )?;
        return Ok(ZielAufbau { hw, ziel: Aufnahmeziel::Kopie });
    };

    // Ein Pool statt zweier: er ist zugleich Aufnahme-Warteschlange UND
    // Bildquelle des Encoders. Das geht nur, weil ein P010-Pool ohnehin in
    // Einzeltexturen angelegt wird (`HwContext::new`) und damit bis zur
    // Arbeitsmenge wächst, statt an einer festen Array-Größe zu hängen.
    let hw = HwContext::new(
        device.clone(),
        context.clone(),
        dst_w,
        dst_h,
        HwPoolConfig {
            pool_size,
            sw_format: AVPixelFormat::AV_PIX_FMT_P010LE,
            // RENDER_TARGET, damit die beiden Ebenen als Zeichenziel taugen —
            // SHADER_RESOURCE nimmt `HwContext::new` selbst dazu.
            extra_bind_flags: D3D11_BIND_RENDER_TARGET.0 as u32,
            ..Default::default()
        },
    )?;
    // Die Sperre des gerade gebauten Pools: auf ihr serialisieren ab jetzt der
    // Zeichendurchgang (Rückruf-Faden) und das Einschieben in den Encoder
    // (Taktfaden). Genau dafür ist sie da — aber sie wird jetzt von einem
    // anderen Faden genommen als vorher, deshalb steht es hier ausdrücklich.
    let zeichner = HdrZeichner::new(device.clone(), context.clone(), dst_w, dst_h, hw.lock_ptr())?;
    eprintln!(
        "[aufnahme] Farbwandlung im Aufnahme-Rückruf: scRGB (fp16) {breite}x{hoehe} → \
         PQ/BT.2020 → P010 {dst_w}x{dst_h}, keine Zwischenkopie \
         (zurück: PULSE_HQ_HDR_ZWISCHENKOPIE=1)"
    );
    Ok(ZielAufbau { hw, ziel: Aufnahmeziel::Wandlung(zeichner) })
}

impl Aufnahmeziel {
    /// Das WGC-Bild in die Pool-Textur bringen.
    pub(super) fn schreiben(
        &mut self,
        hw: &HwContext,
        src: &ID3D11Texture2D,
        dst: &OwnedHwFrame,
    ) -> Result<()> {
        match self {
            // Die WGC-Textur ist eine gewöhnliche Textur, also Array-Scheibe 0.
            Aufnahmeziel::Wandlung(z) => z.wandeln_in(src.as_raw(), 0, dst),
            Aufnahmeziel::Kopie => kopieren(hw, src, dst),
        }
    }
}

/// Das WGC-Bild in eine Pool-Textur kopieren — **nötig, weil die WGC-Textur nur
/// innerhalb des Rückrufs gültig ist**, der Taktfaden sie aber später abholt.
///
/// **Was das kostet, ist gemessen und nicht klein:** 1,82 ms auf der 3D-Einheit
/// je Bild bei 2560×1440 in fp16 (HDR), 0,96 ms bei 8 bit — die Kosten folgen
/// exakt der Bytezahl. Bei 60 fps und bewegtem Bild sind das rund 12 % der
/// 3D-Einheit des Senders. Sie fällt auch für Bilder an, die der Taktfaden
/// gleich wieder verwirft (die Aufnahme ist auf `0,9/fps` gedeckelt, liefert
/// also ~11 % mehr Bilder als der Takt verbraucht).
///
/// **Deshalb ist sie in HDR seit dem 2026-08-07 nicht mehr der Regelfall**,
/// sondern nur noch der Weg unter `PULSE_HQ_HDR_ZWISCHENKOPIE=1` — und für SDR,
/// wo die Farbwandlung über den Video-Prozessor läuft (Modul-Doku oben).
fn kopieren(hw: &HwContext, src: &ID3D11Texture2D, dst: &OwnedHwFrame) -> Result<()> {
    hw.lock();
    let result = unsafe {
        let dst_raw = dst.texture_raw();
        // `from_raw_borrowed` braucht `&*mut c_void` — benannter Slot reicht.
        match ID3D11Texture2D::from_raw_borrowed(&dst_raw) {
            Some(dst_tex) => {
                hw.device_context().CopySubresourceRegion(
                    dst_tex,
                    dst.subresource_index(),
                    0,
                    0,
                    0,
                    src,
                    0,
                    None,
                );
                Ok(())
            }
            None => Err(anyhow!("pool frame texture is null")),
        }
    };
    hw.unlock();
    result
}
