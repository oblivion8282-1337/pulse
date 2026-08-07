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
use pulse_kms_helfer::karte::BildFehler;

use super::kms::{Ausgang, KmsKarte};
use super::kms_helfer::Helfer;
use super::pipewire_stream::{DmabufFrame, FrameMailbox};

/// Woher die Bilder kommen. **Die Wahl faellt an einem Versuch, nicht an einer
/// Vermutung:** wer ohnehin die Rechte hat (Labor, `sudo`, gesetzte
/// Faehigkeit), holt sich das Bild unmittelbar und braucht das Helfer-Programm
/// nie; alle anderen gehen darueber. Eine Abfrage der eigenen Faehigkeiten
/// waere die schlechtere Probe — DRM-Master zu sein reicht ebenfalls, und das
/// steht in keiner Rechteliste.
enum Bildquelle {
    Unmittelbar(KmsKarte),
    UeberHelfer { helfer: Helfer, ausgang: String },
}

impl Bildquelle {
    fn bild(&mut self, crtc: u32, pts: u64) -> Result<DmabufFrame> {
        match self {
            Self::Unmittelbar(k) => k.bild(crtc, pts, 0).map_err(|e| anyhow::anyhow!("{e}")),
            // `ausgang: &mut String` deref-coerct zu `&str` — kein Klonen bei
            // jedem Bild noetig (das lief hier vorher mit, unnoetig, weil das
            // Bild dutzende Male pro Sekunde geholt wird).
            Self::UeberHelfer { helfer, ausgang } => helfer.bild(ausgang, pts, 0),
        }
    }
}

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
        let (mut quelle, erstes) = match karte.bild(ausgang.crtc_id, 0, 0) {
            Ok(bild) => (Bildquelle::Unmittelbar(karte), bild),
            Err(BildFehler::KeineRechte) => {
                // Der Regelfall in der ausgelieferten App. Kein Warnton: dass
                // ein Flatpak die Faehigkeit nicht traegt, ist so vorgesehen.
                tracing::info!(
                    target: "stream",
                    "Scanout: ohne eigene Berechtigung — Bilder kommen ueber den Helfer"
                );
                let mut helfer = Helfer::verbinden_oder_starten()?;
                let bild = helfer
                    .bild(&ausgang.name, 0, 0)
                    .context("erstes Bild ueber den Helfer holen")?;
                (
                    Bildquelle::UeberHelfer { helfer, ausgang: ausgang.name.clone() },
                    bild,
                )
            }
            Err(e) => return Err(anyhow::anyhow!("{e}")).context("erstes Bild vom Scanout holen"),
        };

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
                    match quelle.bild(crtc, n) {
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
