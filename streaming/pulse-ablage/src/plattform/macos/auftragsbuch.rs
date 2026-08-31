//! Das Auftragsbuch: wie die Zustandsmaschine den Eigner-Faden bittet, etwas
//! am Fach zu tun — und wie sie erfaehrt, dass es geschehen ist.
//!
//! **Abgetrennt von [`super::faden`] der Groesse wegen** (`PLAN.md` §12.1);
//! der Schnitt liegt an derselben Naht wie auf Windows
//! (`win-hq-sidecar/src/ablage/auftragsbuch.rs`): dort steht der Faden selbst
//! (Run-Loop, Poll, der blockierende Rueckruf), hier das Protokoll zwischen den
//! beiden Faeden.
//!
//! **Warum es das ueberhaupt gibt:** der Rueckruf
//! `pasteboard:provideDataForType:` kommt auf der Run-Loop des Eigner-Fadens
//! an, und wer ihn bedienen will, muss dort sein. Die Zustandsmaschine laeuft
//! aber auf dem Takt des Verbrauchers. Sie gibt einen Auftrag und wartet.
//!
//! **Der Unterschied zu Windows ist der Weckruf.** Dort traegt eine
//! Fensternachricht (`PostMessageW`) den Auftrag zum Fenster; hier sieht der
//! Faden in seinem eigenen Takt nach (20 ms). Ein zweiter Weg — eine
//! CFRunLoopSource nur zum Wecken — waere ein zweites Stueck
//! CoreFoundation-Zustand fuer 20 ms Ersparnis an einem Vorgang, der ein paar
//! Mal je Sitzung stattfindet.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Sender, channel};

use objc2_app_kit::NSPasteboard;

use super::eigner::Eigner;
use super::faden::{AUFTRAG_FRIST, eigenen_stand_verbuchen, steht};
use super::{fach, stand};

/// Was der Eigner-Faden auf Bitten der Zustandsmaschine tut.
///
/// **Alle Vorgaenge am Fach laufen auf DIESEM Faden**, obwohl `NSPasteboard`
/// keine Faden-Bindung verlangt. Der Grund ist der Rueckruf: er wird dem
/// Eigentuemer zugestellt, und wer ihn bedienen will, muss die Run-Loop
/// bedienen, auf der er ankommt. Alles an einer Stelle zu halten ist die
/// einzige Fassung dieser Zuordnung, die nicht raten muss.
pub(super) enum Auftrag {
    /// Beanspruchen **ohne Daten** — das verzoegerte Rendern.
    Beanspruchen,
    /// Freigeben. `Some` schreibt den Vorbestand zurueck, `None` raeumt.
    Freigeben(Option<String>),
    /// Die FREMDE Auswahl lesen.
    Lesen,
}

static AUFTRAEGE: Mutex<Vec<(u64, Auftrag, Sender<()>)>> = Mutex::new(Vec::new());
static AUFTRAG_NR: AtomicU64 = AtomicU64::new(0);

/// Einen Auftrag geben und auf seine Ausfuehrung warten.
///
/// **Synchron, und das ist tragend:** die Buchfuehrung darueber, ob wir die
/// Ablage halten, fragt unmittelbar danach die Plattform
/// (`crate::lage::takt::freigeben`). Liefe der Auftrag nebenher, meldete sie
/// den Stand von vorher — und der Vorbestand des Nutzers haengt daran.
pub(super) fn auftrag(a: Auftrag) {
    if !steht() {
        return;
    }
    let nr = AUFTRAG_NR.fetch_add(1, Ordering::Relaxed);
    let (fertig, warten) = channel::<()>();
    AUFTRAEGE.lock().unwrap_or_else(|e| e.into_inner()).push((nr, a, fertig));
    // Ein wartender Rueckruf haelt den Faden fest; er gibt ihn frei, sobald
    // etwas ansteht (s. [`super::faden::rendern`]).
    stand().abbrechen();
    if warten.recv_timeout(AUFTRAG_FRIST).is_err() {
        // **Den eigenen Auftrag wieder entnehmen.** Er KANN inzwischen gelaufen
        // sein (dann findet sich nichts mehr), oder er steht noch aus — und
        // dann soll er es nicht mehr: er liefe beim naechsten Durchlauf ausser
        // der Reihe, zu einem Zeitpunkt, an dem die Zustandsmaschine laengst
        // etwas anderes glaubt.
        AUFTRAEGE.lock().unwrap_or_else(|e| e.into_inner()).retain(|(n, _, _)| *n != nr);
        eprintln!("[ablage] Eigner-Faden antwortet nicht — Auftrag zurueckgenommen.");
    }
}

pub(super) fn auftraege_abarbeiten(pb: &NSPasteboard, eigner: &Eigner) {
    let offen = std::mem::take(&mut *AUFTRAEGE.lock().unwrap_or_else(|e| e.into_inner()));
    for (_nr, a, fertig) in offen {
        match a {
            Auftrag::Beanspruchen => {
                let neu = fach::beanspruchen(pb, eigner);
                eigenen_stand_verbuchen(neu, true);
            }
            Auftrag::Freigeben(Some(text)) => {
                let neu = fach::zurueckschreiben(pb, &text);
                // Zurueckgeschrieben heisst: eine neue eigene Belegung mit dem
                // gemerkten Text. Wir bleiben Eigentuemer, aber was in der
                // Ablage liegt, gehoert wieder dem Nutzer.
                eigenen_stand_verbuchen(neu, true);
            }
            Auftrag::Freigeben(None) => {
                let neu = fach::raeumen(pb);
                eigenen_stand_verbuchen(neu, false);
            }
            Auftrag::Lesen => {
                // **Die eigene Ablage wird nicht gelesen.** Halten wir sie mit
                // verzoegertem Rendern, schickte `stringForType` uns unseren
                // EIGENEN Rueckruf — auf ebendiesem Faden, der gerade hier
                // steht: ein Selbstblock bis zur Render-Frist. Was dort liegt,
                // kam ohnehin von der Gegenseite; „nichts Eigenes" ist die
                // richtige Antwort, und sie steht sofort fest.
                let eigen = stand().eigen();
                let text = if eigen { None } else { fach::lesen(pb) };
                stand().lesen_fertig(text);
            }
        }
        let _ = fertig.send(());
    }
}
