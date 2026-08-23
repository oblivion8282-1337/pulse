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

/// Harte Obergrenze — ab hier gibt die Schlange den Strom auf (Notbremse).
///
/// [`MAX_WARTEND`] deckelt nur, was verwerfbar ist. Eine reine Tasten- oder
/// Knopfflut (gehaltene Taste mit Tastenwiederholung, waehrend die Abgabe
/// steht) enthaelt nichts Verwerfbares und liesse die Schlange sonst
/// **unbegrenzt** wachsen — in einem Prozess, der fremde Eingabe verarbeitet,
/// ist ein unbegrenzter Puffer keine Option.
///
/// **16 x [`MAX_WARTEND`]**: die Flutkontrolle haelt eine Schlange schon ab 256
/// fuer verstopft; erst das Sechzehnfache davon heisst „die Abgabe steht
/// wirklich still". In Zeit gerechnet sind 4096 unverwerfbare Frames bei
/// Tastenwiederholung (rund 30 Ereignisse je Sekunde) ueber zwei Minuten
/// ununterbrochenes Tippen ohne eine einzige Abholung — im gesunden Betrieb
/// holt die Fensterschleife alle 8 ms ab.
///
/// **Was dann passiert, steht bei [`Schlange::uebervoll`]**: nicht kappen,
/// sondern den Strom neu beginnen. Ein Hello gibt beim Host alles Gedrueckte
/// frei — die Reparatur ist damit im Protokoll schon vorgesehen, waehrend
/// blindes Wegwerfen einzelner Frames genau das Hoch-Ereignis erwischen kann,
/// dessen Verlust eine Taste am fremden Rechner klemmen laesst.
pub const MAX_GESAMT: usize = MAX_WARTEND * 16;

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
    /// Wie viele UNVERWERFBARE Frames gefallen sind — das passiert nur bei der
    /// Notbremse (s. [`MAX_GESAMT`]) und ist ein Betriebsfehler, kein
    /// Normalfall. Getrennt gezaehlt, damit beides im Protokoll auseinander zu
    /// halten ist.
    verworfene_frames: u64,
}

impl Schlange {
    pub fn verworfene_bewegungen(&self) -> u64 {
        self.verworfene_bewegungen
    }

    pub fn verworfene_frames(&self) -> u64 {
        self.verworfene_frames
    }

    /// Ist die harte Grenze erreicht (s. [`MAX_GESAMT`])?
    ///
    /// Der Aufrufer ([`super::Erfassung`]) beginnt daraufhin einen neuen Strom,
    /// statt hier einzelne Frames zu opfern: nur er kennt die Menge des
    /// Gedrueckten und kann sie mit vergessen, und nur ueber den Weg „neuer
    /// Strom" bekommt der Host sein Hello, mit dem er alles freigibt.
    pub fn uebervoll(&self) -> bool {
        self.frames.len() >= MAX_GESAMT
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
    /// dahinter (nur wenn es `uebernehmen` erlaubt), ueberholte Bewegungen weg.
    ///
    /// Die Begruendung fuer jeden der Halbsaetze steht bei
    /// [`super::Erfassung::strom_beginnen`] — sie ist protokollarisch, nicht
    /// technisch, und gehoert deshalb dorthin.
    pub fn neuer_strom(&mut self, hello: Rahmen, uebernehmen: bool) {
        if uebernehmen {
            let behalten = self.behaltmaske();
            let (mut i, mut gefallen) = (0usize, 0u64);
            self.frames.retain(|_| {
                let bleibt = behalten[i];
                i += 1;
                gefallen += u64::from(!bleibt);
                bleibt
            });
            self.verworfene_bewegungen += gefallen;
        } else {
            for rahmen in self.frames.drain(..) {
                if rahmen.ist_bewegung() {
                    self.verworfene_bewegungen += 1;
                } else {
                    self.verworfene_frames += 1;
                }
            }
        }
        self.frames.push_front(hello);
    }

    /// Staut sich die Warteschlange, fallen die AELTESTEN Bewegungen — und nur
    /// die verwerfbaren. Bleibt nichts uebrig, waechst sie weiter: Tasten,
    /// Knoepfe und Rad werden nie verworfen (die harte Grenze zieht dann
    /// [`MAX_GESAMT`]).
    ///
    /// **Bleibt O(n) je Bewegung, und das mit Absicht.** Welche Bewegung fallen
    /// darf, haengt daran, was NACH ihr steht (s. [`Self::behaltmaske`]) — das
    /// ist ohne Blick auf die Folge nicht zu beantworten, und ein Zaehler oder
    /// ein zweiter Index waere ein Zustand, der beim Zusammenfassen, Leeren und
    /// Neubeginnen mitgepflegt werden muesste. Der Preis ist klein: der
    /// Durchlauf beginnt erst ueber [`MAX_WARTEND`], laeuft also nur im Stau,
    /// [`MAX_GESAMT`] deckelt ihn nach oben, und **eine reine Tasten- oder
    /// Knopfflut kommt hier gar nicht vorbei** — sie laeuft ueber
    /// `Erfassung::einreihen`, das nicht kappt, sondern die Notbremse prueft
    /// (O(1)).
    fn kappen(&mut self) {
        while self.frames.len() > MAX_WARTEND {
            let Some(pos) = self.behaltmaske().iter().position(|behalten| !behalten) else {
                return;
            };
            self.frames.remove(pos);
            self.verworfene_bewegungen += 1;
        }
    }

    /// Fuer jeden Frame: darf er bleiben, wenn Bewegungen gekuerzt werden?
    ///
    /// `false` steht ausschliesslich bei Bewegungen — alles andere bleibt
    /// immer. Eine Bewegung bleibt, wenn sie die **Positionierung** eines
    /// Knopf- oder Rad-Frames ist, also die letzte Bewegung vor ihm
    /// (s. [`Rahmen::braucht_position`]). Ohne diese Ausnahme klickte der Host
    /// dort, wo sein Zeiger zufaellig steht.
    ///
    /// Ein Durchlauf von HINTEN: `haengt_dran` sagt, ob seit der zuletzt
    /// gesehenen Bewegung noch etwas kam, das eine Position braucht. Eine
    /// Bewegung, auf die das zutrifft, ist die Positionierung genau dieses
    /// Anhaengsels; alles davor haengt nicht mehr an ihr.
    ///
    /// Die Regel steht nur hier — [`Self::kappen`] und [`Self::neuer_strom`]
    /// nehmen beide diese Maske, damit sie nicht auseinanderlaufen koennen.
    fn behaltmaske(&self) -> Vec<bool> {
        let mut behalten = vec![true; self.frames.len()];
        let mut haengt_dran = false;
        for (i, rahmen) in self.frames.iter().enumerate().rev() {
            if rahmen.braucht_position() {
                haengt_dran = true;
            } else if rahmen.ist_bewegung() {
                behalten[i] = haengt_dran;
                haengt_dran = false;
            }
        }
        behalten
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
    /// Sitzung: die Hoch-Ereignisse aus `Erfassung::ausschalten` duerfen nicht mit
    /// dem Fenster verschwinden.
    pub fn raeumen(&mut self) -> Option<Vec<String>> {
        if self.frames.is_empty() {
            return None;
        }
        Some(self.leeren())
    }

    fn leeren(&mut self) -> Vec<String> {
        self.frames.drain(..).map(|r| rahmen::kodiere(r.as_slice())).collect()
    }
}
