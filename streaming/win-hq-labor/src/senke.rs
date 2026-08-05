//! Der eigene WHIP-Sendeweg als [`PaketSenke`] der Bibliothek.
//!
//! Das ist die Naht zwischen Labor und Sidecar. Der Sidecar encodiert wie
//! immer — Aufnahme, Skalierung, Taktung, Encoder-Optionen, alles unverändert
//! — und reicht die fertigen Pakete hierher statt an den Muxer. Warum die Naht
//! genau hier liegt und nicht als zweite Encoder-Fassung, steht in
//! `pulse_win_hq_sidecar::encode::senke`.
//!
//! **Was dieser Weg kann, was der Muxer nicht kann:**
//!
//! - **Einen Rückkanal.** Über RTMPS gibt es keinen; ein Zuschauer mit einer
//!   Lücke im Bild wartet dort bis zum nächsten regulären Vollbild. Hier
//!   erreicht seine Anforderung den Encoder (`whip::mod` empfängt sie und
//!   setzt `keyframe::request_keyframe`).
//! - **AV1.** FFmpegs eigener WHIP-Muxer trägt nur H.264 — und auf Windows
//!   läuft er ohnehin nicht (Schannel-DTLS, gemessen 2026-08-02).
//! - **Bild und Ton auf getrennten Zeitleisten.** Der Muxer gibt ein Bild erst
//!   frei, wenn Ton mit passendem Zeitstempel vorliegt; der Rückstand des Tons
//!   wird damit eins zu eins zur Bild-Latenz. Am 2026-07-28 über die echte
//!   Leitung gemessen: RTMPS mit Ton 143 ms, ohne Ton 116,8 ms.
//!
//! **Der Taktfaden ruft hier nicht direkt an.** Zwischen Encoder und dieser
//! Senke sitzt ein eigener Faden mit begrenzter Warteschlange
//! (`encode::senke_writer`) — Paketieren, Verschlüsseln und `sendto` laufen
//! dort, nicht im Takt. Die Methoden unten dürfen also blockieren; was sie
//! aufhalten, ist die Warteschlange, nicht die Bildkadenz.

use std::time::Duration;

use anyhow::{Context, Result};
use pulse_win_hq_sidecar::encode::{PaketSenke, SenkenAuftrag};

use crate::whip::WhipSender;
use crate::whip::av1_entpacken::ZEITTRENNER;

/// Beim Programmstart aufrufen — danach nimmt jeder Stream auf eine
/// `http(s)://`-URL diesen Weg statt des FFmpeg-WHIP-Muxers.
///
/// **Welche URLs das sind, entscheidet die Bibliothek**, nicht dieses Modul —
/// eine zweite Schema-Liste hier würde früher oder später von ihrer abweichen,
/// und dann liefe entweder ein RTMPS-Stream in einen WebRTC-Sender oder ein
/// WHIP-Stream still über den Muxer.
pub fn anmelden() {
    pulse_win_hq_sidecar::encode::registriere_senken_bauer(verbinde);
}

/// Denselben Sendeweg direkt aufbauen, ohne den Umweg über die Anmeldung.
///
/// Braucht der Vulkan-Encoder (`vulkan_encoder.rs`): der wird selbst über die
/// Encoder-Anmeldung gebaut und bekommt die Senke deshalb nicht durchgereicht —
/// er holt sie sich hier. Eine zweite Fassung des Aufbaus wäre die schlechtere
/// Antwort.
///
/// **Ist das Ziel keine WHIP-URL, wird in eine Datei geschrieben** — roher
/// Bitstrom, ohne Container. Das ist kein Nebenweg, sondern das
/// Mess-Werkzeug: nur so lässt sich mit `ffprobe` unabhängig nachzählen, wie
/// viele Vollbilder wirklich im Strom stehen. Dem Log des Senders zu glauben
/// hat am 2026-08-02 schon einmal einen Fehler verdeckt.
/// `breite`/`hoehe` sind die ZIEL-Maße des Encoders. Die Bibliothek verlangt sie
/// seit dem 2026-08-04, weil das SDP-Angebot daraus die H.264-Fassung und die
/// AV1-Stufe ableitet — zu klein angesetzt steigt der Hardware-Decoder des
/// Zuschauers aus und fällt still auf Software zurück (am 2026-08-02 genau so
/// passiert, Level 3.0 bei 720p). Der Sender dieses Labors bestimmt die Stufe
/// zwar selbst (`whip/av1_level.rs`), aber der Auftrag wird trotzdem ehrlich
/// gefüllt: ein erfundener Wert wäre eine zweite Wahrheit.
pub fn baue_sendeweg(
    url: &str,
    codec: &str,
    fps: u32,
    breite: u32,
    hoehe: u32,
) -> Result<Box<dyn PaketSenke>> {
    if pulse_win_hq_sidecar::encode::output::is_whip_url(url) {
        return verbinde(&SenkenAuftrag { url, codec, fps, breite, hoehe });
    }
    Ok(Box::new(DateiSenke::neu(url)?))
}

/// Schreibt die rohen Encoder-Pakete hintereinander in eine Datei.
///
/// Kein Container: bei AV1 ergibt das den „low overhead bitstream", den
/// `ffprobe -f av1` liest; bei H.264 den Annex-B-Strom. Für die Frage „wie
/// viele Vollbilder sind drin" reicht das, und es hat keine Zeitbasis, die
/// etwas verfälschen könnte.
struct DateiSenke {
    datei: std::io::BufWriter<std::fs::File>,
}

impl DateiSenke {
    fn neu(pfad: &str) -> Result<Self> {
        let f = std::fs::File::create(pfad)
            .with_context(|| format!("Datei anlegen: {pfad}"))?;
        eprintln!("[senke] Ausgabe in die Datei {pfad} (roher Bitstrom, zum Nachmessen)");
        Ok(Self { datei: std::io::BufWriter::new(f) })
    }
}

impl PaketSenke for DateiSenke {
    /// `pts` bleibt ungenutzt, und das ist hier richtig: geschrieben wird ein
    /// roher Bitstrom ohne Container und ohne Zeitbasis. Genau darum ist die
    /// Datei das taugliche Messmittel — `ffprobe` zählt die Vollbilder, ohne
    /// dass eine Zeitrechnung dazwischenreden kann.
    fn video(&mut self, daten: &[u8], _pts: Option<i64>) -> Result<()> {
        use std::io::Write;
        self.datei.write_all(&ZEITTRENNER).context("Zeittrenner schreiben")?;
        self.datei.write_all(daten).context("Bild schreiben")
    }
    fn audio(&mut self, _daten: &[u8], _dauer: Duration) -> Result<()> {
        Ok(()) // Ton hat in einem rohen Bildstrom nichts verloren.
    }
    fn schliesse(&mut self) {
        use std::io::Write;
        let _ = self.datei.flush();
    }
}

fn verbinde(auftrag: &SenkenAuftrag) -> Result<Box<dyn PaketSenke>> {
    let sender = WhipSender::connect(auftrag.url, auftrag.codec, auftrag.fps).with_context(|| {
        // Die URL trägt das Push-Token — deshalb NICHT roh, sondern durch die
        // Maskierung der Bibliothek. Sie ganz wegzulassen wäre die schlechtere
        // Antwort: dann sagt der Fehler nicht mehr, welches Ziel scheiterte,
        // und genau das hat beim ersten Handschlag am 2026-08-02 gefehlt.
        format!(
            "WHIP-Aufbau zu {} ({}, {} fps)",
            pulse_win_hq_sidecar::redact::secrets(auftrag.url),
            auftrag.codec,
            auftrag.fps
        )
    })?;
    Ok(Box::new(WhipSenke { sender }))
}

struct WhipSenke {
    sender: WhipSender,
}

impl PaketSenke for WhipSenke {
    /// **Der `pts` wird hier bewusst NICHT benutzt**, obwohl die Bibliothek ihn
    /// seit dem 2026-08-04 mitliefert. Der Sender dieses Labors rechnet den
    /// RTP-Zeitstempel ganzzahlig aus der Bildzahl (`whip::Av1Zustand`) — genau
    /// deshalb ist AV1 hier gegen den abgeschnittenen 90-kHz-Zeitstempel immun,
    /// der bei H.264 gemessen wurde (`ton-2026-08-02-windows-messstand.json`).
    ///
    /// **Das ist eine Abweichung von der ausgelieferten Fassung**, die inzwischen
    /// den echten `pts` verwendet, und sie gehört auf die Rückport-Liste in
    /// `CLAUDE.md`: ein Bildzähler unterstellt, dass jedes eingeschobene Bild
    /// auch eines wird. Solange das Labor mit fester Bildrate und ohne
    /// Bild-Duplizierung misst, stimmt beides überein; unter Last müsste es
    /// nicht mehr.
    fn video(&mut self, daten: &[u8], _pts: Option<i64>) -> Result<()> {
        self.sender.send(daten)
    }

    fn audio(&mut self, daten: &[u8], dauer: Duration) -> Result<()> {
        self.sender.send_audio(daten, dauer)
    }

    fn schliesse(&mut self) {
        self.sender.close();
    }
}
