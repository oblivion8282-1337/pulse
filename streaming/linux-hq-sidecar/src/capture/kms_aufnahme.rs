//! Der laufende Teil der Scanout-Aufnahme: ein Thread, der im Takt Bilder vom
//! Scanout holt und in dieselbe [`FrameMailbox`] legt, die der Portal-Weg
//! benutzt. Alles dahinter (Import, Skalierung, Encode) bleibt unveraendert.
//!
//! **Warum getaktet und nicht ereignisgesteuert.** Der Compositor weckt uns
//! hier nicht — es gibt kein Gegenstueck zum PipeWire-Rueckruf. Wir holen
//! deshalb selbst, mit der Bildrate des Streams. Zwei Folgen, die man kennen
//! muss:
//!
//! * Ein **stehender Bildschirm** liefert trotzdem Bilder (der Scanout-Puffer
//!   liegt ja da). Beim Portal-Weg ist das anders — dort schickt der Compositor
//!   nur bei Damage, und der Takt-Loop dupliziert. Fuer die Gleichmaessigkeit
//!   ist das hier also eher besser.
//! * Wir koennen ein Bild **verpassen oder doppelt sehen**, weil unser Takt und
//!   der des Bildschirms nicht gekoppelt sind. Bei 60 Bildern gegen 280 Hz
//!   Bildwiederholung faellt das nicht auf; wer mit der vollen Rate aufnimmt,
//!   sollte es messen. Ungemessen.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};

use super::kms::{Ausgang, KmsKarte};
use super::pipewire_stream::FrameMailbox;

/// Laufende Scanout-Aufnahme. [`stop`](Self::stop) beendet den Thread.
pub struct KmsAufnahme {
    laeuft: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl KmsAufnahme {
    /// Aufnahme eines Ausgangs starten. Der Ausgang wird hier — also noch im
    /// aufrufenden Thread — aufgeloest, damit ein falscher Name oder eine
    /// fehlende Berechtigung sofort als Fehler zurueckkommt und nicht erst
    /// stumm im Worker landet.
    pub fn start(
        wunsch: Option<&str>,
        fps: u32,
    ) -> Result<(Arc<FrameMailbox>, Ausgang, Self)> {
        let karte = KmsKarte::erste_mit_ausgaengen()?;
        let ausgang = karte.ausgang_waehlen(wunsch)?;
        // Ein Bild sofort holen: das ist die Probe auf die Berechtigung. Ohne
        // sie liefe der Worker an und der Fehler ("keine Handles") erschiene
        // erst als Zeitueberschreitung beim Warten auf das erste Bild.
        let erstes = karte
            .bild(ausgang.crtc_id, 0, 0)
            .context("erstes Bild vom Scanout holen")?;

        let frames = FrameMailbox::new();
        let laeuft = Arc::new(AtomicBool::new(true));
        frames.put(erstes);

        let takt = Duration::from_secs_f64(1.0 / fps.max(1) as f64);
        let crtc = ausgang.crtc_id;
        let ziel = Arc::clone(&frames);
        let flagge = Arc::clone(&laeuft);
        let worker = thread::Builder::new()
            .name("hq-kms-capture".into())
            .spawn(move || {
                let start = Instant::now();
                let mut n: u64 = 1;
                while flagge.load(Ordering::SeqCst) {
                    let faellig = start + takt.mul_f64(n as f64);
                    if let Some(rest) = faellig.checked_duration_since(Instant::now()) {
                        thread::sleep(rest);
                    }
                    if !flagge.load(Ordering::SeqCst) {
                        break;
                    }
                    match karte.bild(crtc, n, 0) {
                        Ok(f) => ziel.put(f),
                        Err(e) => {
                            // Ein Ausgang kann verschwinden (Kabel, Umschalten
                            // der Anzeige). Das ist ein Ende der Quelle, kein
                            // Grund weiterzulaufen — der Encode-Loop soll es
                            // sehen statt das letzte Bild ewig zu wiederholen.
                            tracing::warn!(
                                target: "stream",
                                "Scanout-Aufnahme endet: {e:#}"
                            );
                            break;
                        }
                    }
                    n += 1;
                }
                ziel.close();
            })
            .context("Thread hq-kms-capture starten")?;

        Ok((frames, ausgang, Self { laeuft, worker: Some(worker) }))
    }

    pub fn stop(&mut self) {
        self.laeuft.store(false, Ordering::SeqCst);
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
    }
}

impl Drop for KmsAufnahme {
    fn drop(&mut self) {
        self.stop();
    }
}
