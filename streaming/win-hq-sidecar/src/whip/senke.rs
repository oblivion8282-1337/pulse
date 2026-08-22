//! Der eigene WebRTC-Sendeweg als [`PaketSenke`] — die Stelle, an der er in
//! den ausgelieferten Sidecar eingehängt wird.
//!
//! **Warum als Senke und nicht als zweiter Encoder-Weg.** Alles bis zum
//! fertigen Paket bleibt eine einzige Implementierung; nur das letzte Stück
//! unterscheidet sich (Begründung in [`crate::encode::senke`]). Der
//! Linux-Sidecar hat dieselbe Gabelung an derselben Stelle, dort nur ohne die
//! Naht — er hat nur einen Encoder-Weg, hier sind es drei.
//!
//! **Warum die Anmeldung im Binary steht und nicht hier.** Ein Vorgabe-Bauer in
//! der Bibliothek würde jeden Nutzer der Bibliothek stillschweigend auf diesen
//! Weg schicken — auch das Labor, das seinen eigenen anmeldet. Ein Test in
//! `encode::senke` hält das ausdrücklich fest. Deshalb ruft `main.rs` die
//! Anmeldung, nicht `lib.rs`.

use std::time::Duration;

use anyhow::{Context, Result};

use crate::encode::senke::{PaketSenke, SenkenAuftrag};
use super::WhipSender;

/// Der Bauer, den `main.rs` anmeldet.
///
/// Scheitert der Aufbau, bricht der Start ab — kein stiller Rückfall auf den
/// Muxer. Der wäre die schlimmere Antwort: der Stream liefe, aber ohne
/// Rückkanal, und bei 60 s Vollbild-Abstand wartete ein Zuschauer bis zu eine
/// Minute auf sein erstes Bild, ohne dass irgendwo ein Fehler auftaucht.
pub fn baue(auftrag: &SenkenAuftrag) -> Result<Box<dyn PaketSenke>> {
    let sender = WhipSender::connect(
        auftrag.url,
        auftrag.codec,
        auftrag.fps,
        auftrag.breite,
        auftrag.hoehe,
        auftrag.bitrate_kbps,
    )
    .context("WHIP-Sitzung aufbauen")?;
    Ok(Box::new(WhipSenke { sender }))
}

struct WhipSenke {
    sender: WhipSender,
}

impl PaketSenke for WhipSenke {
    fn video(&mut self, daten: &[u8], pts: Option<i64>) -> Result<()> {
        self.sender.send(daten, pts)
    }

    fn audio(&mut self, daten: &[u8], dauer: Duration) -> Result<()> {
        self.sender.send_audio(daten, dauer)
    }

    fn schliesse(&mut self) {
        self.sender.close();
    }
}
