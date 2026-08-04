//! Der **Ton-Arm** des Zuschauers: empfangen, dekodieren, in Blöcke zerlegen.
//!
//! **Warum es den gibt.** Das Messwerk hat den Ton bis zum 2026-08-02 nur
//! leergelesen — es zählte Bilder, und alle Laborzahlen waren damit tonblind.
//! Belegt war deshalb nur, dass am Server eine Opus-Spur *ankommt*. Ob sie
//! sauber klingt und zum Bild passt, konnte niemand sagen, weil es niemand
//! messen konnte. Genau diese Lücke hat beim Bild (10-Bit-Magenta) zwei Wochen
//! gekostet.
//!
//! **Was hier NICHT passiert: urteilen.** Diese Datei sammelt nur — je
//! Opus-Paket ein [`Block`] mit Zeit, 1-kHz-Anteil je Kanal und Lautstärke. Die
//! Auswertung steht daneben in [`super::tonurteil`], und das ist Absicht: eine
//! Messung, die im selben Atemzug schwellwertet, lässt sich hinterher nicht
//! nachrechnen. Der Rohsatz bleibt, die Deutung ist austauschbar.
//!
//! **Die Zeit kommt aus dem RTP-Zeitstempel, nicht aus der Ankunft.** Das ist
//! der ganze Punkt der Übung: Bild und Ton laufen auf dem eigenen Sendeweg auf
//! zwei getrennten Nennwert-Uhren (Bild aus der Bildzahl, Ton aus den
//! Paketlängen). Ob die auseinanderlaufen, sieht man nur an ihren eigenen
//! Zeitstempeln — die Ankunftszeit misst die Leitung mit. Beides wird
//! mitgeschrieben, weil es zwei verschiedene Fragen beantwortet (s.
//! [`super::tonurteil`]).

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use anyhow::{Context, Result, anyhow};

/// Ein ausgewerteter Opus-Frame (heute 5 ms, s. `encode::audio::opus_frame_ms`).
#[derive(Clone, Copy)]
pub(super) struct Block {
    /// Millisekunden in der **Ton-Zeitleiste des Senders** (RTP-Uhr, 48 kHz),
    /// gerechnet ab dem ersten empfangenen Paket.
    pub(super) ms_uhr: f64,
    /// Millisekunden seit Messbeginn, als das Paket **ankam**.
    pub(super) ms_ankunft: f64,
    /// Anteil bei 1 kHz — der Piep. Je Kanal, weil das Referenzsignal ihn
    /// abwechselnd links und rechts legt: eine zusammengefallene Stereo-Spur
    /// (in dieser Kette schon einmal passiert, s. `noiseFilter.ts`) fällt sonst
    /// nicht auf.
    pub(super) piep_links: f32,
    pub(super) piep_rechts: f32,
    /// Lautstärke über alles. Der Träger im Referenzsignal ist **nie still** —
    /// Stille IST der Fehler, nicht die Ruhe zwischen zwei Pieps.
    pub(super) lautstaerke: f32,
}

/// Sammelstelle für die Tonspur. Zähler atomar, Blöcke unter einer Sperre —
/// geschrieben wird nur vom Auswerte-Faden, gelesen erst am Ende.
#[derive(Default)]
pub(super) struct Tonwerk {
    pub(super) pakete: AtomicU64,
    /// Sprünge in der Sequenznummer = **auf der Leitung** verlorene Pakete.
    pub(super) seq_luecken: AtomicU64,
    /// Sprünge im RTP-Zeitstempel über die Paketlänge hinaus = eine Lücke, die
    /// der **Sender** schon hatte (WASAPI hat nichts geliefert, oder die
    /// Stille-Auffüllung hat gegriffen). Die beiden auseinanderzuhalten ist der
    /// Grund, warum hier zwei Zähler stehen und nicht einer: sie zeigen auf
    /// verschiedene Schuldige, und ohne die Trennung sucht man den Fehler in
    /// der falschen Hälfte der Kette.
    pub(super) ts_luecken: AtomicU64,
    pub(super) ts_luecken_ms: AtomicU64,
    pub(super) bloecke: Mutex<Vec<Block>>,
}

impl Tonwerk {
    /// Die Tonspur bis zu ihrem Ende bedienen.
    ///
    /// **Lesen hier, dekodieren nebenan** — dieselbe Begründung wie bei der
    /// Bildspur (`messwerk.rs`): Rechenarbeit in der Leseschleife lässt den
    /// Empfangspuffer überlaufen, und das Messwerk misst dann sich selbst.
    /// Opus ist zwar billig, aber „billig genug" ist keine Zusage, die man in
    /// einer Messung braucht.
    pub(super) async fn lauf(
        self: &std::sync::Arc<Self>,
        track: &webrtc::track::track_remote::TrackRemote,
        t0: Instant,
    ) {
        let (tx, rx) = std::sync::mpsc::channel::<(Vec<u8>, u32, f64)>();
        let werk = std::sync::Arc::clone(self);
        let faden = std::thread::Builder::new()
            .name("messwerk-ton".into())
            .spawn(move || {
                if let Err(e) = werk.dekodiere(rx) {
                    eprintln!("[messwerk] Ton-Decoder beendet: {e:#}");
                }
            })
            .expect("Ton-Faden starten");

        let mut letzte_seq: Option<u16> = None;
        let mut letzter_ts: Option<u32> = None;
        loop {
            let Ok((paket, _)) = track.read_rtp().await else { break };
            self.pakete.fetch_add(1, Ordering::Relaxed);
            let seq = paket.header.sequence_number;
            if letzte_seq.is_some_and(|l| seq != l.wrapping_add(1)) {
                self.seq_luecken.fetch_add(1, Ordering::Relaxed);
            }
            letzte_seq = Some(seq);

            let ts = paket.header.timestamp;
            if let Some(vorher) = letzter_ts {
                // Erwartet wird genau eine Paketlänge. Alles darüber ist eine
                // Lücke in der Zeitleiste des Senders; `wrapping_sub` deckt den
                // Überlauf der 32-bit-Uhr ab (nach gut 24 Stunden bei 48 kHz —
                // in einer Messung nie, in einem Dauerbetrieb schon).
                let schritt = ts.wrapping_sub(vorher);
                let erwartet = 48 * super::ton_paket_ms() as u32;
                if schritt > erwartet {
                    self.ts_luecken.fetch_add(1, Ordering::Relaxed);
                    let fehl = (schritt - erwartet) as u64 / 48;
                    self.ts_luecken_ms.fetch_add(fehl, Ordering::Relaxed);
                }
            }
            letzter_ts = Some(ts);

            let ms_ankunft = t0.elapsed().as_secs_f64() * 1000.0;
            if tx.send((paket.payload.to_vec(), ts, ms_ankunft)).is_err() {
                break;
            }
        }
        drop(tx);
        let _ = faden.join();
    }

    /// Zählwerte und Blöcke zu einem Urteil zusammenführen.
    ///
    /// Die Zähler stehen hier, die Deutung nebenan — deshalb reicht diese
    /// Methode nur durch und rechnet nichts.
    pub(super) fn ernte(&self, bilder: &[super::tonurteil::Bildblock]) -> super::TonErgebnis {
        let bloecke = self.bloecke.lock().expect("Ton-Blöcke vergiftet");
        let mut e = super::tonurteil::urteile(&bloecke, bilder);
        e.pakete = self.pakete.load(Ordering::Relaxed);
        e.seq_luecken = self.seq_luecken.load(Ordering::Relaxed);
        e.ts_luecken = self.ts_luecken.load(Ordering::Relaxed);
        e.ts_luecken_ms = self.ts_luecken_ms.load(Ordering::Relaxed);
        e
    }

    /// Pakete entgegennehmen, dekodieren, je Frame einen [`Block`] ablegen.
    fn dekodiere(&self, von_lesen: std::sync::mpsc::Receiver<(Vec<u8>, u32, f64)>) -> Result<()> {
        let mut decoder = OpusDecoder::neu()?;
        let mut ts0: Option<u32> = None;
        while let Ok((daten, ts, ms_ankunft)) = von_lesen.recv() {
            let anfang = *ts0.get_or_insert(ts);
            // Auf die erste Ankunft beziehen, damit die Zahl lesbar bleibt;
            // `wrapping_sub` wegen des Uhr-Überlaufs.
            let ms_uhr = ts.wrapping_sub(anfang) as f64 / 48.0;
            let pcm = match decoder.frame(&daten) {
                Ok(p) => p,
                // **Ein kaputtes Paket beendet die Messung nicht.** Nach einem
                // Verlust ist genau das zu erwarten, und ein Abbruch verlöre
                // den ganzen Lauf für einen Frame.
                Err(_) => continue,
            };
            let (piep_links, piep_rechts) = (goertzel(&pcm, 0, 1000.0), goertzel(&pcm, 1, 1000.0));
            let lautstaerke = rms(&pcm);
            self.bloecke.lock().expect("Ton-Blöcke vergiftet").push(Block {
                ms_uhr,
                ms_ankunft,
                piep_links,
                piep_rechts,
                lautstaerke,
            });
        }
        Ok(())
    }
}

/// Dünne Hülle um den Opus-Decoder.
///
/// **`libopus` und nicht `opus`.** Der eingebaute Decoder heißt genauso und ist
/// im gepatchten Bau nicht dabei; ein Rückfall auf einen Namen, der zufällig
/// existiert, hat beim Bild schon einmal einen halben Tag gekostet
/// (`av1_amf` als „Decoder"). Deshalb hier: gibt es ihn nicht, bricht es ab.
struct OpusDecoder {
    decoder: ffmpeg_next::codec::decoder::Audio,
    ziel: ffmpeg_next::frame::Audio,
}

impl OpusDecoder {
    fn neu() -> Result<Self> {
        ffmpeg_next::init().context("ffmpeg::init")?;
        let desc = ffmpeg_next::codec::decoder::find_by_name("libopus")
            .ok_or_else(|| anyhow!("libopus fehlt im gelinkten FFmpeg — ohne ihn kein Ton"))?;
        let mut ctx = ffmpeg_next::codec::context::Context::new_with_codec(desc);
        // **Vor dem Öffnen setzen, sonst öffnet libopus gar nicht.** Anders als
        // ein Video-Decoder leitet er Rate und Kanäle nicht aus dem Strom ab —
        // über RTP gibt es keinen Container, der sie mitbrächte. Ohne das
        // scheitert `open` mit „Number of channels must be 1 or 2".
        // SAFETY: der Kontext ist frisch angelegt und noch nicht geöffnet.
        unsafe {
            let p = ctx.as_mut_ptr();
            (*p).sample_rate = 48_000;
            ffmpeg_next::ffi::av_channel_layout_default(&mut (*p).ch_layout, 2);
        }
        let decoder = ctx.decoder().audio().context("libopus-Decoder öffnen")?;
        Ok(Self { decoder, ziel: ffmpeg_next::frame::Audio::empty() })
    }

    /// Ein Opus-Paket vorlegen und die Abtastwerte als **interleaved f32**
    /// zurückgeben (Stereo).
    fn frame(&mut self, daten: &[u8]) -> Result<Vec<f32>> {
        let paket = ffmpeg_next::Packet::copy(daten);
        self.decoder.send_packet(&paket).context("send_packet")?;
        let mut aus = Vec::new();
        while self.decoder.receive_frame(&mut self.ziel).is_ok() {
            let f = &self.ziel;
            let kanaele = f.planes().max(1);
            match f.format() {
                // Der Regelfall bei libopus: ein Ebene, Werte verschränkt.
                ffmpeg_next::format::Sample::F32(ffmpeg_next::format::sample::Type::Packed) => {
                    aus.extend_from_slice(f.plane::<f32>(0));
                }
                // Planar kommt vor, wenn FFmpeg anders gebaut wurde — dann die
                // Ebenen selbst verschränken statt die Messung zu verlieren.
                ffmpeg_next::format::Sample::F32(ffmpeg_next::format::sample::Type::Planar) => {
                    let links = f.plane::<f32>(0);
                    let rechts = if kanaele > 1 { f.plane::<f32>(1) } else { links };
                    for i in 0..links.len().min(rechts.len()) {
                        aus.push(links[i]);
                        aus.push(rechts[i]);
                    }
                }
                ffmpeg_next::format::Sample::I16(ffmpeg_next::format::sample::Type::Packed) => {
                    aus.extend(f.plane::<i16>(0).iter().map(|v| *v as f32 / 32768.0));
                }
                other => return Err(anyhow!("unerwartetes Abtastformat vom Decoder: {other:?}")),
            }
        }
        Ok(aus)
    }
}

/// Anteil einer einzelnen Frequenz in einem Block — Goertzel statt FFT.
///
/// **Warum keine FFT.** Gesucht ist genau eine Frequenz, und ein 240-Werte-Block
/// bei 48 kHz trifft 1 kHz exakt auf einen Korb (k = 5). Goertzel kostet dafür
/// eine Multiplikation je Wert und braucht keine Abhängigkeit — eine FFT wäre
/// mehr Code und mehr Rechenzeit für dieselbe Zahl.
fn goertzel(verschraenkt: &[f32], kanal: usize, hz: f32) -> f32 {
    let n = verschraenkt.len() / 2;
    if n == 0 {
        return 0.0;
    }
    let k = (n as f32 * hz / 48_000.0).round();
    let w = 2.0 * std::f32::consts::PI * k / n as f32;
    let koeff = 2.0 * w.cos();
    let (mut s1, mut s2) = (0.0f32, 0.0f32);
    for i in 0..n {
        let s = verschraenkt[i * 2 + kanal] + koeff * s1 - s2;
        s2 = s1;
        s1 = s;
    }
    ((s1 * s1 + s2 * s2 - koeff * s1 * s2).max(0.0)).sqrt() / (n as f32 / 2.0)
}

/// Lautstärke über beide Kanäle.
fn rms(verschraenkt: &[f32]) -> f32 {
    if verschraenkt.is_empty() {
        return 0.0;
    }
    let summe: f32 = verschraenkt.iter().map(|v| v * v).sum();
    (summe / verschraenkt.len() as f32).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ein reiner 1-kHz-Ton muss im 1-kHz-Korb landen und ein 220-Hz-Träger
    /// nicht — sonst zeigt jeder Piep-Fund auf den Träger.
    #[test]
    fn goertzel_trennt_piep_vom_traeger() {
        let mut piep = Vec::new();
        let mut traeger = Vec::new();
        for i in 0..240 {
            let t = i as f32 / 48_000.0;
            let p = (2.0 * std::f32::consts::PI * 1000.0 * t).sin() * 0.25;
            let c = (2.0 * std::f32::consts::PI * 220.0 * t).sin() * 0.25;
            piep.push(p);
            piep.push(0.0);
            traeger.push(c);
            traeger.push(0.0);
        }
        assert!(goertzel(&piep, 0, 1000.0) > 0.2, "Piep muss im Korb liegen");
        assert!(goertzel(&traeger, 0, 1000.0) < 0.02, "Träger darf nicht hineinlecken");
        assert!(goertzel(&piep, 1, 1000.0) < 0.01, "rechter Kanal ist still");
    }

    #[test]
    fn rms_erkennt_stille() {
        assert!(rms(&[0.0; 480]) < 1e-6);
        assert!(rms(&[0.5; 480]) > 0.4);
    }
}
