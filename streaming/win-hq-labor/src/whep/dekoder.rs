//! Der Decoder des Messwerks — und das Prüfen einer Mitschrift ohne Netz.
//!
//! Steht getrennt von [`super`], weil es eine andere Frage beantwortet: dort
//! „was kommt an und wann", hier „ist daraus ein Bild zu machen". Genau diese
//! Trennung war am 2026-08-02 der Unterschied zwischen einer Stunde Suche im
//! Strom und einem Blick auf den Decoder-Namen.

use anyhow::{Context, Result, anyhow, bail};

/// Eine Mitschrift (oder irgendeinen rohen AV1-Strom) offline durch denselben
/// Decoder schicken, den auch der Zuschauer benutzt.
///
/// **Wozu.** Wenn am lebenden Strom nichts dekodiert, gibt es drei Verdächtige:
/// die Mitschrift selbst, der Weg dorthin, oder der Decoder. Diese Funktion
/// nimmt den ersten heraus — sie liest die Datei, teilt an den Zeittrennern und
/// legt jeden Zeitabschnitt einzeln vor, genau wie im Betrieb. Was hier
/// dekodiert, ist in Ordnung; was hier scheitert, war schon in der Datei
/// kaputt.
pub fn pruefe_datei(pfad: &str, mime: &str) -> Result<(u64, u64)> {
    let roh = std::fs::read(pfad).with_context(|| format!("lesen: {pfad}"))?;
    let abschnitte = teile_an_zeittrennern(&roh)?;
    let mut decoder = Decoder::neu(mime)?;
    let (mut gut, mut schlecht) = (0u64, 0u64);
    for a in &abschnitte {
        match decoder.bild(a) {
            Ok((Ausgang::Bild | Ausgang::Vollbild, _)) => gut += 1,
            Ok((Ausgang::Nichts, _)) => {}
            Ok((Ausgang::Beschaedigt, _)) | Err(_) => schlecht += 1,
        }
    }
    eprintln!(
        "[pruefe] {pfad}: {} Abschnitte, {gut} dekodiert, {schlecht} abgelehnt",
        abschnitte.len()
    );
    Ok((gut, schlecht))
}

/// Einen rohen AV1-Strom in Zeitabschnitte teilen, indem die OBUs **richtig
/// durchlaufen** werden.
///
/// **Nicht an der Bytefolge `12 00` suchen.** Das war der erste Anlauf und ist
/// falsch: dieselben zwei Bytes kommen auch mitten in komprimierten Bilddaten
/// vor, der Schnitt landet dann irgendwo im Bild, und der Decoder meldet
/// „Invalid data" — für eine Datei, die vollkommen in Ordnung ist. Ein
/// Prüfwerkzeug, das so scheitert, beschuldigt den Falschen.
fn teile_an_zeittrennern(roh: &[u8]) -> Result<Vec<&[u8]>> {
    use crate::whip::av1_entpacken::{OBU_ZEITTRENNER, obus};
    let mut aus = Vec::new();
    let mut abschnitt_start = 0usize;
    for o in obus(roh)? {
        if o.typ == OBU_ZEITTRENNER && o.start > abschnitt_start {
            aus.push(&roh[abschnitt_start..o.start]);
            abschnitt_start = o.start;
        }
    }
    if abschnitt_start < roh.len() {
        aus.push(&roh[abschnitt_start..]);
    }
    Ok(aus)
}

/// Dünne Hülle um den FFmpeg-Decoder. Kein Bild wird aufgehoben — es zählt nur,
/// OB eines herauskam.
pub(super) struct Decoder {
    decoder: ffmpeg_next::codec::decoder::Video,
    /// Ziel für `receive_frame`, wiederverwendet. `Video::empty()` je
    /// Zeitabschnitt wäre ein `av_frame_alloc`/`_free` je Bild, obwohl
    /// `avcodec_receive_frame` das Ziel selbst zurücksetzt.
    ziel: ffmpeg_next::frame::Video,
}

impl Decoder {
    pub(super) fn neu(mime: &str) -> Result<Self> {
        ffmpeg_next::init().context("ffmpeg::init")?;
        // **Mehrere Namen je Codec, in dieser Reihenfolge**, weil das Labor und
        // der ausgelieferte Sidecar gegen verschiedene FFmpeg-Bauten linken.
        //
        // **Der Name `av1` steht bewusst zuletzt und ist eine Falle**: das ist
        // KEIN Software-Decoder, sondern eine reine Hardware-Hülle. Ohne
        // passenden Beschleuniger nimmt sie jedes Bild an und liefert keines,
        // mit der Meldung „Your platform doesn't support hardware
        // acceleration". Am 2026-08-02 hat mich das eine Stunde gekostet: das
        // Messwerk meldete „0 Bilder dekodiert", ich suchte den Fehler im
        // Strom — und der Strom war in Ordnung, nur der Decoder war keiner.
        //
        // `libdav1d` ist der richtige (den benutzen auch Browser), fehlt aber
        // im gepatchten Bau. `av1_amf` ist dort der einzige, der wirklich
        // dekodiert.
        let namen: &[&str] = match mime.to_ascii_lowercase().as_str() {
            m if m.ends_with("av1") => &["libdav1d", "libaom-av1", "av1_amf", "av1"],
            m if m.ends_with("h264") => &["h264"],
            other => bail!("kein Decoder fuer {other}"),
        };
        let (name, desc) = namen
            .iter()
            .find_map(|n| ffmpeg_next::codec::decoder::find_by_name(n).map(|d| (*n, d)))
            .ok_or_else(|| anyhow!("keiner von {namen:?} im gelinkten FFmpeg"))?;
        eprintln!("[messwerk] Decoder: {name}");
        let decoder = ffmpeg_next::codec::context::Context::new_with_codec(desc)
            .decoder()
            .video()
            .with_context(|| format!("Decoder '{name}' oeffnen"))?;
        Ok(Self { decoder, ziel: ffmpeg_next::frame::Video::empty() })
    }

    /// Einen Zeitabschnitt vorlegen.
    ///
    /// Die zweite Zahl ist die **mittlere Helligkeit** des zuletzt
    /// ausgegebenen Bildes. Sie hängt hier und nicht in einem eigenen Werkzeug,
    /// weil das Bild nur an dieser Stelle existiert — aufgehoben wird es
    /// weiterhin nicht. Gebraucht wird sie für den Blitz des Referenzsignals,
    /// also für die Ton-Bild-Messung (`super::tonurteil`).
    pub(super) fn bild(&mut self, daten: &[u8]) -> Result<(Ausgang, f32)> {
        let paket = ffmpeg_next::Packet::copy(daten);
        self.decoder.send_packet(&paket).context("send_packet")?;
        let frame = &mut self.ziel;
        let mut aus = Ausgang::Nichts;
        let mut hell = 0.0f32;
        while self.decoder.receive_frame(frame).is_ok() {
            // **`decode_error_flags` zusätzlich zum CORRUPT-Bit.** Das Bit setzt
            // FFmpeg nur, wenn schon der Container-Leser den Schaden gemeldet
            // hat — über RTP gibt es keinen. Die Fehlerflags dagegen füllt der
            // Decoder selbst (fehlende Referenz, verworfene Blöcke), und genau
            // das ist hier der Fall.
            // SAFETY: `frame` ist gueltig, solange dieser Block laeuft.
            let fehler = unsafe { (*frame.as_ptr()).decode_error_flags } != 0;
            aus = if frame.is_corrupt() || fehler {
                Ausgang::Beschaedigt
            } else if frame.is_key() {
                Ausgang::Vollbild
            } else {
                Ausgang::Bild
            };
            hell = helligkeit(frame);
        }
        Ok((aus, hell))
    }
}

/// Mittlere Helligkeit der Y-Ebene, an einem groben Raster abgetastet.
///
/// **Jeder sechzehnte Bildpunkt reicht** — gesucht ist ein Vollbild-Blitz, kein
/// Detail. Über alle Punkte zu laufen kostete bei 720p30 rund 28 Millionen
/// Zugriffe je Sekunde in einem Faden, der nebenher dekodiert; die Messung
/// würde damit sich selbst bremsen, und das ist die Sorte Fehler, die wie ein
/// Netzproblem aussieht.
///
/// **10 Bit wird auf sein oberes Byte gelesen.** Ein 16-bit-Wert byteweise zu
/// mitteln ergäbe Unsinn (das untere Byte springt zwischen 0 und 255), und
/// genau die Bittiefe, die auf dieser Karte schon einmal ein falsches Bild
/// geliefert hat, darf hier nicht still danebenliegen.
fn helligkeit(frame: &ffmpeg_next::frame::Video) -> f32 {
    use ffmpeg_next::format::Pixel;
    let zehn_bit = !matches!(frame.format(), Pixel::YUV420P | Pixel::NV12 | Pixel::YUVJ420P);
    let daten = frame.data(0);
    let schritt = frame.stride(0);
    let hoehe = frame.height() as usize;
    let breite = frame.width() as usize;
    if daten.is_empty() || schritt == 0 || hoehe == 0 || breite == 0 {
        return 0.0;
    }
    let (mut summe, mut anzahl) = (0u64, 0u64);
    for y in (0..hoehe).step_by(4) {
        let zeile = y * schritt;
        for x in (0..breite).step_by(4) {
            let i = zeile + if zehn_bit { x * 2 + 1 } else { x };
            if let Some(v) = daten.get(i) {
                summe += *v as u64;
                anzahl += 1;
            }
        }
    }
    if anzahl == 0 { 0.0 } else { summe as f32 / anzahl as f32 }
}

/// Was beim Vorlegen eines Zeitabschnitts herauskam.
///
/// **Die Unterscheidung `Bild` / `Beschaedigt` ist der Kern des Werkzeugs.**
/// Ohne sie zählt es „der Decoder hat etwas ausgegeben" — und dav1d gibt auch
/// dann etwas aus, wenn ihm die Referenzen fehlen. Am 2026-08-02 sah die
/// Erholung deshalb erst nach 65 ms aus, mit und ohne Anforderung gleich; in
/// Wahrheit war das nur der nächste Zeitabschnitt, nicht das nächste richtige
/// Bild. Eine Zahl, die nicht misst, was ihr Name sagt, ist schlimmer als keine.
pub(super) enum Ausgang {
    /// Kein Bild (der Decoder sammelt noch).
    Nichts,
    /// Ein Bild, das der Decoder ohne Beanstandung ausgegeben hat.
    Bild,
    /// Dasselbe, aber ein **Vollbild**.
    ///
    /// **Das ist der Nachweis, dass Intra-Refresh läuft**, und zwar am
    /// Zuschauer statt am Log des Senders: mit Intra-Refresh darf im ganzen
    /// Lauf höchstens eines kommen (das auf die Einstiegs-Anforderung), ohne
    /// sind es beim Zwei-Sekunden-Takt viele. Am 2026-08-02 gewählt, weil der
    /// Umweg über eine Mitschrift bei AV1 nicht trägt: die rohe OBU-Datei hat
    /// keinen Sequenzkopf, den ein Leser vorfinden könnte, und `ffprobe` meldet
    /// dann „No sequence header available" für einen Strom, der vollkommen in
    /// Ordnung ist. Der Decoder weiss es ohnehin.
    Vollbild,
    /// Ein Bild, zu dem der Decoder Fehler gemeldet hat — es ist da, aber
    /// falsch.
    Beschaedigt,
}
