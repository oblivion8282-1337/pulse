//! Die Warteschlange der fertigen Frames: Zusammenfassen, Flutkontrolle, Takt.
//!
//! Abgetrennt von [`super`], weil dort die UEBERSETZUNG wohnt (welches
//! winit-Ereignis welchen Frame ergibt) und hier die AUSLIEFERUNG (was davon
//! wann und ob ueberhaupt hinausgeht). Beides in einer Datei war ueber die
//! Groessen-Grenze gewachsen (`PLAN.md` §12.1), und die Naht liegt ohnehin
//! genau hier: was in diesem Modul steht, kennt keinen Zeiger, keine Taste und
//! kein Bild — nur Opcodes und Zeit.
//!
//! **Die eine Regel, die alles hier traegt:** verworfen werden ausschliesslich
//! Bewegungen. Ein verschlucktes Key-Up ist eine klemmende Taste am fremden
//! Rechner, eine verschluckte Bewegung ist nichts (so steht es in der
//! Wire-Spec, und so fahren es Moonlight/Sunshine auch).

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use super::rahmen::{self, Rahmen};

/// Hoechstens eine Bewegung je Takt — so steht es in der Wire-Spec.
///
/// **8 ms**, also 125 Abgaben je Sekunde: knapp unter dem Bildabstand bei
/// 144 fps (6,9 ms) und weit ueber allem, was ein Mensch als Verzoegerung
/// bemerkt. Ohne diesen Takt schriebe der Player eine JSON-Zeile je
/// Mausabtastung — gemessen bis zu 900 je Sekunde (s. `FRAME_FLOW_WINDOW` in
/// `app`), und das fuer Positionen, die die naechste ohnehin ueberholt.
///
/// **Tasten, Knoepfe und Rad warten NICHT auf den Takt** (s. [`Schlange::abholen`]):
/// sie sind selten, und bei ihnen zaehlt jede Millisekunde.
pub const BEWEGUNGSTAKT: Duration = Duration::from_millis(8);

/// Obergrenze der Warteschlange, ab der Bewegungen fallen.
///
/// Sie greift nur, wenn die Abgabe steht (Electron liest nicht mehr) — im
/// Normalbetrieb liegt hoechstens eine Handvoll Frames darin, weil
/// aufeinanderfolgende Bewegungen zusammengefasst werden. **Tasten, Knoepfe und
/// Rad zaehlen mit, werden aber nie verworfen.**
pub const MAX_WARTEND: usize = 256;

/// Was bei einer Abholung herauskommt.
#[derive(Debug, PartialEq, Eq)]
pub enum Abgabe {
    /// Nichts angefallen.
    Nichts,
    /// Es liegt etwas an, aber erst zu diesem Zeitpunkt (Bewegungstakt).
    Spaeter(Instant),
    /// Fertige Frames, Base64, in Reihenfolge.
    Jetzt(Vec<String>),
}

/// Die Frames, die auf ihre Abgabe warten.
#[derive(Debug, Default)]
pub struct Schlange {
    frames: VecDeque<Rahmen>,
    /// Wann zuletzt abgegeben wurde. `None` = noch nie, dann darf sofort.
    letzte_abgabe: Option<Instant>,
    /// Wie viele Bewegungen gefallen sind. Reine Diagnose, aber die einzige
    /// Stelle, an der ein Frame lautlos verschwindet.
    verworfene_bewegungen: u64,
}

impl Schlange {
    pub fn verworfene_bewegungen(&self) -> u64 {
        self.verworfene_bewegungen
    }

    /// Einen unverzichtbaren Frame einreihen (Taste, Knopf, Rad, Hello). Wird
    /// nie verworfen — auch dann nicht, wenn die Schlange ueber [`MAX_WARTEND`]
    /// hinauswaechst.
    pub fn einreihen(&mut self, rahmen: Rahmen) {
        self.frames.push_back(rahmen);
    }

    /// Eine Bewegung einreihen — mit Zusammenfassung und Flutkontrolle.
    ///
    /// Absolute Bewegungen **ersetzen** die letzte (die alte Position ist
    /// ueberholt), relative werden **aufsummiert** (jede Differenz zaehlt).
    /// Genau so steht es in der Wire-Spec.
    pub fn bewegung(&mut self, neu: Rahmen) {
        if let Some(letzter) = self.frames.back_mut() {
            if letzter.opcode() == neu.opcode() {
                match (letzter.rel_werte(), neu.rel_werte()) {
                    (Some((ax, ay)), Some((bx, by))) => {
                        *letzter = rahmen::maus_rel(ax.saturating_add(bx), ay.saturating_add(by));
                    }
                    _ => *letzter = neu,
                }
                return;
            }
        }
        self.frames.push_back(neu);
        self.kappen();
    }

    /// Einen neuen Eingabestrom beginnen: `hello` nach VORN, Liegengebliebenes
    /// dahinter, Bewegungen weg.
    ///
    /// Die Begruendung fuer jede der drei Halbsaetze steht bei
    /// [`super::Erfassung::strom_beginnen`] — sie ist protokollarisch, nicht
    /// technisch, und gehoert deshalb dorthin.
    pub fn neuer_strom(&mut self, hello: Rahmen) {
        let vorher = self.frames.len();
        self.frames.retain(|r| !r.ist_bewegung());
        self.verworfene_bewegungen += (vorher - self.frames.len()) as u64;
        self.frames.push_front(hello);
    }

    /// Staut sich die Warteschlange, fallen die AELTESTEN Bewegungen — und nur
    /// die. Bleibt nichts Verwerfbares uebrig, waechst sie weiter: Tasten,
    /// Knoepfe und Rad werden nie verworfen.
    fn kappen(&mut self) {
        while self.frames.len() > MAX_WARTEND {
            let Some(pos) = self.frames.iter().position(Rahmen::ist_bewegung) else {
                return;
            };
            self.frames.remove(pos);
            self.verworfene_bewegungen += 1;
        }
    }

    /// Abholen, wenn es Zeit ist.
    ///
    /// Sofort, sobald etwas Unverzichtbares wartet (Taste, Knopf, Rad, Hello);
    /// sonst hoechstens einmal je [`BEWEGUNGSTAKT`]. Der Ruecklauf
    /// [`Abgabe::Spaeter`] sagt dem Aufrufer, wann er wiederkommen muss — ohne
    /// ihn bliebe die letzte Bewegung einer Geste liegen, bis zufaellig das
    /// naechste Ereignis eintrifft.
    pub fn abholen(&mut self, jetzt: Instant) -> Abgabe {
        if self.frames.is_empty() {
            return Abgabe::Nichts;
        }
        let nur_bewegung = self.frames.iter().all(Rahmen::ist_bewegung);
        if nur_bewegung {
            if let Some(letzte) = self.letzte_abgabe {
                let faellig = letzte + BEWEGUNGSTAKT;
                if jetzt < faellig {
                    return Abgabe::Spaeter(faellig);
                }
            }
        }
        self.letzte_abgabe = Some(jetzt);
        Abgabe::Jetzt(self.leeren())
    }

    /// Alles herausnehmen, ohne auf den Takt zu warten. Fuer den Abbau einer
    /// Sitzung: die Hoch-Ereignisse aus `Erfassung::setzen` duerfen nicht mit
    /// dem Fenster verschwinden.
    pub fn raeumen(&mut self) -> Option<Vec<String>> {
        if self.frames.is_empty() {
            return None;
        }
        Some(self.leeren())
    }

    fn leeren(&mut self) -> Vec<String> {
        self.frames.drain(..).map(|r| rahmen::base64(r.as_slice())).collect()
    }
}
