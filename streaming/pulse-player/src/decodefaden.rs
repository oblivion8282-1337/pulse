//! Der Bild-Decoder auf einem eigenen Faden.
//!
//! ## Warum
//!
//! `decode()` ist synchron und wartet dabei auf die Grafikeinheit. Bis zum
//! 2026-08-16 lief es INLINE in der Sitzungsschleife (`session::run`), also in
//! derselben `select!`-Schleife, die auch RTP abholt, Pakete zu Einheiten
//! zusammensetzt, Tonpakete an den Ton-Faden weiterreicht und Befehle des
//! Fensters annimmt. Blieb die Grafikeinheit haengen — gemessen zwei Sekunden,
//! bis der Kernel ihren Videoring zuruecksetzte —, stand die ganze Schleife.
//!
//! Der Schaden war messbar und traf ausgerechnet das, was mit dem Bild gar
//! nichts zu tun hat: `Ton — Unterlaeufe 553` und 857562 verworfene
//! Ton-Abtastwerte in einem Lauf. Der Ton-Faden dekodiert laengst selbst
//! (`mediasink::play_audio`), aber seine Pakete kommen ueber DIESE Schleife —
//! zwei Sekunden ohne Nachschub leeren seinen Puffer, und danach kommt alles
//! auf einmal. Dasselbe galt fuer die Befehle des Fensters.
//!
//! Das Bild selbst gewinnt hier nichts: haengt der Decoder, gibt es kein Bild,
//! egal auf welchem Faden er sitzt. Es geht um alles ANDERE.
//!
//! ## Wie
//!
//! Ein gewoehnlicher Betriebssystem-Faden (kein Tokio-Arbeiter: die Arbeit ist
//! blockierend und dauert im Fehlerfall Sekunden — genau das, was man einem
//! Arbeiterpool nicht zumutet). Auftraege gehen als Nachricht hinein, fertige
//! Bilder gehen am Faden vorbei direkt an das Fenster, und was die Schleife vom
//! Decoder wissen muss, liest sie aus [`Zustand`].
//!
//! **Die Warteschlange ist unbegrenzt, aber ueberwacht.** Ein Deckel mit
//! Verwerfen waere hier falsch: eine verworfene Einheit reisst die
//! Referenzkette, und Bilder mit fehlenden Bezugsbildern sind der
//! wahrscheinlichste Grund, aus dem die Grafikeinheit ueberhaupt haengenbleibt
//! — der Deckel wuerde also genau den Zustand verschlimmern, wegen dem er
//! zuschlaegt. Zwei Sekunden Rueckstand sind rund 60 Einheiten zu je etwa
//! 7,5 KB; das traegt jede Maschine. Laeuft es wirklich aus dem Ruder, endet
//! die Sitzung ueber [`SCHLANGE_MAX`] statt lautlos Speicher zu fressen.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering::Relaxed};
use std::sync::{Arc, Mutex};


use bytes::Bytes;
use tokio::sync::mpsc;

use crate::whep::Codec;
use crate::decode::{Sendeart, VideoDecoder};
use crate::session::{SessionEvent, Zeitmarken};

/// Ab wieviel Rueckstand die Sitzung endet.
///
/// 300 Einheiten sind bei 30 Bildern je Sekunde zehn Sekunden. Der belegte
/// Fall (haengender Videoring) dauert zwei; wer zehn Sekunden zurueckliegt,
/// holt das nicht mehr auf, und ein weiter wachsender Rueckstand waere nur noch
/// Speicherverbrauch vor demselben Ende.
const SCHLANGE_MAX: usize = 300;

/// Was der Faden zu tun bekommt. Reihenfolge zaehlt — eine Luecke muss zwischen
/// genau den Einheiten liegen, zwischen denen sie aufgetreten ist, sonst
/// verwirft der Decoder die falschen Bilder.
enum Auftrag {
    Einheit(Bytes, Zeitmarken),
    Luecke,
}

/// Warum der Faden aufgehoert hat.
pub struct Ende {
    pub grund: String,
    pub gescheitert: bool,
}

/// Was die Sitzungsschleife vom Decoder wissen muss, ohne ihn zu besitzen.
#[derive(Default)]
pub struct Zustand {
    /// Der Decoder wartet auf einen Einstiegspunkt — die Schleife fordert dann
    /// ein Vollbild nach.
    pub wartet_auf_einstieg: AtomicBool,
    /// Der Faden hat ein Vollbild noetig (Einfrier-Wacht hat zugeschlagen).
    /// Die Schleife nimmt das Zeichen ab und fordert an; der Neuaufbau selbst
    /// ist da schon passiert.
    pub vollbild_noetig: AtomicBool,
    /// Offene Auftraege in der Warteschlange (s. [`SCHLANGE_MAX`]).
    pub offen: AtomicUsize,
    /// Es ist mindestens ein Bild beim Fenster angekommen.
    ///
    /// Die Schleife haengt zwei Entscheidungen daran, die sie ohne den Decoder
    /// nicht treffen kann: den Abbruch „kein Bild nach N Sekunden" und die
    /// Frage, ob ein endender Track ein Fehler ist oder ein sauberes Ende.
    /// Bliebe der Merker in der Schleife, staende er nach dem Umzug des
    /// Decoders fuer immer auf falsch — der Player braeche jede Sitzung nach
    /// dem Zeitlimit ab, obwohl das Bild laeuft.
    pub spielt: AtomicBool,
    /// Ende des Fadens, sofern er aufgehoert hat.
    pub ende: Mutex<Option<Ende>>,

    // --- Messwerte, die sonst in `SessionStats` geschrieben wuerden ---
    pub decode_sum_us: AtomicU64,
    pub decode_count: AtomicU64,
    pub decode_max_us: AtomicU64,
    pub frames_decoded: AtomicU64,
    /// Dekodierte, aber nicht vorzeigbare Bilder (Reparatur nach einer Luecke).
    pub verworfen: AtomicU64,
    /// Bilder, die der Fenster-Faden nicht mehr angenommen hat.
    pub uebersprungen: AtomicU64,
    pub width: AtomicU32,
    pub height: AtomicU32,
    pub ten_bit: AtomicBool,
    pub sendeart: Mutex<Sendeart>,
}

/// Griff auf den Faden. Beim Fallenlassen endet er (der Kanal schliesst).
pub struct Faden {
    auftraege: std::sync::mpsc::Sender<Auftrag>,
    zustand: Arc<Zustand>,
}

impl Faden {
    /// Startet den Faden. Der Decoder entsteht darin, nicht hier — schon sein
    /// Anlegen kann die Grafikeinheit beschaeftigen.
    pub fn starten(
        codec: Codec,
        hwdec: Option<bool>,
        geraet: Option<wgpu::Device>,
        events: mpsc::Sender<SessionEvent>,
    ) -> Self {
        let (auftraege, eingang) = std::sync::mpsc::channel::<Auftrag>();
        let zustand = Arc::new(Zustand::default());
        let z = zustand.clone();
        // Benannt, damit er in `top`/`perf` auffindbar ist — bei einem Faden,
        // der im Fehlerfall Sekunden blockiert, ist das der erste Blick.
        let _ = std::thread::Builder::new()
            .name("pulse-bilddecoder".to_string())
            .spawn(move || arbeiten(codec, hwdec, geraet, events, eingang, z));
        Self { auftraege, zustand }
    }

    pub fn zustand(&self) -> &Zustand {
        &self.zustand
    }

    /// Eine Einheit einreihen. `false` heisst, der Faden ist weg — die Schleife
    /// liest den Grund dann aus [`Zustand::ende`].
    pub fn einheit(&self, daten: Bytes, zeit: Zeitmarken) -> bool {
        self.zustand.offen.fetch_add(1, Relaxed);
        self.auftraege.send(Auftrag::Einheit(daten, zeit)).is_ok()
    }

    /// Eine Bild-Luecke melden.
    pub fn luecke(&self) -> bool {
        self.zustand.offen.fetch_add(1, Relaxed);
        self.auftraege.send(Auftrag::Luecke).is_ok()
    }

    /// Liegt der Faden zu weit zurueck? (s. [`SCHLANGE_MAX`])
    pub fn ueberlastet(&self) -> bool {
        self.zustand.offen.load(Relaxed) > SCHLANGE_MAX
    }
}

/// Der Faden selbst.
fn arbeiten(
    codec: Codec,
    hwdec: Option<bool>,
    geraet: Option<wgpu::Device>,
    events: mpsc::Sender<SessionEvent>,
    eingang: std::sync::mpsc::Receiver<Auftrag>,
    zustand: Arc<Zustand>,
) {
    let mut dec = match VideoDecoder::new(codec, hwdec, geraet) {
        Ok(d) => d,
        Err(e) => return beenden(&zustand, format!("Decoder: {e:#}"), true),
    };
    let mut angekuendigt = false;

    while let Ok(auftrag) = eingang.recv() {
        let ergebnis = match auftrag {
            Auftrag::Luecke => {
                dec.on_gap();
                Ok(())
            }
            Auftrag::Einheit(daten, zeit) => {
                crate::session::bilder_ausgeben(
                    &mut dec,
                    &daten,
                    zeit,
                    &zustand,
                    &mut angekuendigt,
                    &events,
                )
            }
        };
        zustand.offen.fetch_sub(1, Relaxed);

        // Nach jeder Einheit nachfuehren, was die Schleife abfragt. Beides
        // gehoert hierher und nicht in die Schleife: `eingefroren` ist `&mut`
        // (die Wacht fuehrt einen eigenen Pruefabstand) und braucht damit den
        // Decoder, den nur dieser Faden besitzt.
        zustand.wartet_auf_einstieg.store(dec.wartet_auf_einstieg(), Relaxed);
        if dec.eingefroren() {
            dec.wegen_einfrieren_neu();
            zustand.vollbild_noetig.store(true, Relaxed);
        }

        if let Err((grund, gescheitert)) = ergebnis {
            return beenden(&zustand, grund, gescheitert);
        }
    }
    // Kanal geschlossen: die Sitzung ist vorbei, der Faden hat nichts zu melden.
}

fn beenden(zustand: &Zustand, grund: String, gescheitert: bool) {
    if let Ok(mut g) = zustand.ende.lock() {
        g.get_or_insert(Ende { grund, gescheitert });
    }
}
