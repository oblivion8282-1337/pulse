//! Die Naht zwischen Decoder und Bruecke: aus einem GPU-Bild wird ein
//! `DecodedFrame`, der nichts im Hauptspeicher haelt.
//!
//! **Plattformfrei.** Was ein GPU-Bild ist, entscheidet die jeweilige Bruecke
//! (D3D11 unter Windows, CUDA unter Linux); hier steht nur, wie aus ihrem
//! Ergebnis ein `DecodedFrame` wird und was bei einem Fehlschlag geschieht.
//!
//! Getrennt von `decode.rs`, weil die dortige Datei mit 1600 Zeilen weit ueber
//! der Groessengrenze liegt und nicht weiter wachsen soll.

use ffmpeg_next as ffmpeg;

use crate::decode::{DecodedFrame, PixelLayout, PlanePool};

use super::{Bruecke, GpuBild};

/// Ein Bild ueber die Bruecke nehmen. `None` heisst „nicht moeglich" — der
/// Aufrufer nimmt dann den Weg ueber den Hauptspeicher.
///
/// `bruecke` traegt drei Zustaende, und die Unterscheidung ist noetig: `None`
/// heisst „noch nicht versucht" (die Bruecke braucht ein erstes Bild, um an das
/// D3D11-Geraet zu kommen), `Some(Some(_))` heisst „steht", `Some(None)` heisst
/// **„einmal gescheitert, nicht wieder versuchen"**. Letzteres ist kein
/// Aufgeben aus Bequemlichkeit: die Gruende sind allesamt bleibend (anderes
/// Backend, zwei GPUs im Rechner, fremdes Format), und eine Fehlerzeile je Bild
/// waeren bei 60 fps sechzig Zeilen je Sekunde.
/// Zusaetzlich zum Bild kommt die verbrauchte Zeit in Mikrosekunden zurueck.
///
/// **Die muss mit**, sonst schaltet dieser Weg den Stockungs-Waechter aus: der
/// entscheidet daran, ob die Zeit im Warten auf die Grafikeinheit steckt, und
/// sein bisheriger Messpunkt (`av_hwframe_transfer_data`) laeuft hier gar nicht
/// mehr. Genau so lag es im ersten Lauf am 2026-08-06 — zwoelf Stockungen, kein
/// Rueckfall.
pub fn bild_ohne_umweg(
    bruecke: &mut Option<Option<Bruecke>>,
    frame: &ffmpeg::util::frame::video::Video,
    briefkasten: &std::sync::Arc<crate::einfrieren::Briefkasten>,
    geraet: &Option<wgpu::Device>,
) -> (Option<DecodedFrame>, u64) {
    let uhr = std::time::Instant::now();
    let bild = versuchen(bruecke, frame, briefkasten, geraet);
    (bild, uhr.elapsed().as_micros() as u64)
}

fn versuchen(
    bruecke: &mut Option<Option<Bruecke>>,
    frame: &ffmpeg::util::frame::video::Video,
    briefkasten: &std::sync::Arc<crate::einfrieren::Briefkasten>,
    geraet: &Option<wgpu::Device>,
) -> Option<DecodedFrame> {
    let eintrag =
        bruecke.get_or_insert_with(|| match Bruecke::neu(frame, briefkasten.clone(), geraet) {
        Ok(b) => {
            // **Hier stand bis zum 2026-08-06 „Einfrier-Waechter und
            // Latenz-Sonde arbeiten auf diesem Weg NICHT."** Fuer den Waechter
            // ist das seither falsch — sein Fingerabdruck wird auf der GPU
            // gerechnet (`render::abdruck`). Fuer die Sonde gilt es weiter, und
            // sie sagt es beim ersten Bild selbst (`crate::probe`).
            eprintln!(
                "pulse-player: Zero-Copy an — das Bild bleibt im Grafikspeicher. \
                 Der Einfrier-Waechter arbeitet ueber den Fingerabdruck auf der GPU."
            );
            Some(b)
        }
        Err(e) => {
            eprintln!("pulse-player: Zero-Copy nicht moeglich ({e:#}) — Ruecklesen");
            None
        }
    });
    let vorhanden = eintrag.as_mut()?;
    match vorhanden.uebernehmen(frame) {
        Ok(Some(bild)) => Some(gpu_bild(frame, bild)),
        // Gegendruck: kein Ringplatz frei. Dieses eine Bild nimmt den alten
        // Weg, der naechste Versuch laeuft wieder — schweigend, weil es in
        // jedem Anlauf ein paar Mal vorkommt und eine Zeile je Bild das Log
        // unbrauchbar machte.
        Ok(None) => None,
        Err(e) => {
            eprintln!("pulse-player: Zero-Copy gescheitert ({e:#}) — ab jetzt Ruecklesen");
            *bruecke = Some(None);
            None
        }
    }
}

/// Ein Bild, das im Grafikspeicher bleibt.
///
/// Nimmt die Bildbeschreibung vom **GPU-Bild** statt von einer
/// heruntergeladenen Fassung — Groesse, Farbangaben und Bittiefe stehen dort
/// genauso. `planes` und `strides` bleiben leer; wer sie liest, bekommt nichts,
/// und das ist der dokumentierte Preis dieses Weges (Modulkopf von [`super`]).
fn gpu_bild(
    frame: &ffmpeg::util::frame::video::Video,
    gpu: std::sync::Arc<GpuBild>,
) -> DecodedFrame {
    DecodedFrame {
        arrived: None,
        // Beide setzt erst `session.rs`, wie beim Weg ueber den Hauptspeicher.
        rtp_ts: None,
        clock_rate: 0,
        width: frame.width(),
        height: frame.height(),
        // Beide Bruecken liefern NV12 oder P010 — zwei Ebenen mit
        // verschraenktem Chroma. Etwas anderes kaeme hier gar nicht an: beide
        // `Bruecke::neu` weisen jedes andere Format ab.
        format: PixelLayout::BiPlanar420,
        planes: Vec::new(),
        strides: Vec::new(),
        ten_bit: gpu.zehn_bit(),
        full_range: matches!(frame.color_range(), ffmpeg::color::Range::JPEG),
        farbe: crate::decode::farbangaben_fuer(frame),
        gpu: Some(gpu),
        pool: PlanePool::default(),
    }
}
