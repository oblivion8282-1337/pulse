//! Das Auftragsbuch: wie die Zustandsmaschine den Fensterfaden bittet, etwas
//! an der Zwischenablage zu tun — und wie sie erfaehrt, dass es geschehen ist.
//!
//! **Abgetrennt von [`super::fenster`] der Groesse wegen** (`PLAN.md` §12.1);
//! der Schnitt liegt an einer Naht: dort steht der Faden selbst (Fenster,
//! Nachrichtenschleife, der blockierende Rendervorgang), hier das Protokoll
//! zwischen den beiden Faeden.
//!
//! **Warum es das ueberhaupt gibt:** `WM_RENDERFORMAT` wird an den Eigentuemer
//! zugestellt, und Eigentuemer wird das Fenster, mit dem `OpenClipboard`
//! gerufen wurde. Alle Win32-Vorgaenge auf der Ablage muessen deshalb auf dem
//! Faden dieses Fensters laufen — die Zustandsmaschine laeuft aber auf dem
//! Takt-Faden. Sie gibt einen Auftrag und wartet.
//!
//! **Synchron, und das ist tragend:** die Buchfuehrung darueber, ob wir die
//! Ablage halten, fragt unmittelbar nach dem Auftrag die Plattform
//! (`pulse_ablage::lage::takt::freigeben`). Liefe der Auftrag nebenher, meldete
//! sie den Stand von vorher — und der Vorbestand des Nutzers haengt daran.

use std::sync::Mutex;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{Sender, channel};
use std::time::Duration;

use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::PostMessageW;

use super::fach;
use super::fenster::{self, geteilt};

/// Wie lange ein Auftraggeber auf den Fensterfaden wartet.
///
/// **Gefolgert, nicht gemessen.** Im Regelfall ist der Faden untaetig und
/// antwortet in Mikrosekunden; die Frist deckt den einen Fall ab, in dem er
/// gerade in einem Rendervorgang steht — der wird durch
/// [`Ablagestand::abbrechen`] sofort aufgeloest, sobald ein Auftrag ansteht.
///
/// **Was ein Fristablauf kostet, haengt am Auftrag**, und der frueher hier
/// stehende Satz „kostet ein Einfuegen, nie einen falschen Inhalt" stimmte nur
/// fuer [`Auftrag::Lesen`] (Befund B6). Bei [`Auftrag::Freigeben`] liest
/// `pulse_ablage::lage::takt::freigeben` unmittelbar danach `p.eigentuemer()`
/// und entscheidet daran ueber den gemerkten Vorbestand — ein veralteter Stand
/// kann ihn faelschlich verwerfen oder stehen lassen. Deshalb wird der Auftrag
/// beim Fristablauf **entnommen** statt liegengelassen: er soll nicht beim
/// naechsten Anlass ausser der Reihe laufen.
const AUFTRAG_FRIST: Duration = Duration::from_millis(500);

/// Auftraege an den Fensterfaden. Nur er fuehrt Win32-Aufrufe auf der
/// Zwischenablage aus; der Takt-Faden bittet ihn darum und wartet.
///
/// Die Nummer gehoert zum Auftrag, damit der Auftraggeber **genau seinen**
/// wieder entnehmen kann, wenn er ihn nicht mehr will (s. [`auftrag`]).
static AUFTRAEGE: Mutex<Vec<(u64, Auftrag, Sender<()>)>> = Mutex::new(Vec::new());

/// Laufnummer des naechsten Auftrags.
static AUFTRAG_NR: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Was der Fensterfaden auf Bitten der Zustandsmaschine tut.
pub(super) enum Auftrag {
    /// Beanspruchen **ohne Daten** — das verzoegerte Rendern.
    Beanspruchen,
    /// Freigeben. `Some` schreibt den Vorbestand zurueck, `None` raeumt.
    Freigeben(Option<String>),
    /// Die FREMDE Ablage lesen.
    Lesen,
}

/// Einen Auftrag geben und auf seine Ausfuehrung warten.
///
/// **Synchron, und das ist tragend:** die Buchfuehrung darueber, ob wir die
/// Ablage halten, fragt unmittelbar danach die Plattform
/// (`Ablagelage::freigeben`). Liefe der Auftrag nebenher, meldete sie den
/// Stand von vorher — und der Vorbestand des Nutzers haenge davon ab.
pub(super) fn geben(a: Auftrag) {
    let Some(h) = fenster::hwnd() else { return };
    let nr = AUFTRAG_NR.fetch_add(1, Ordering::Relaxed);
    let (fertig, warten) = channel::<()>();
    AUFTRAEGE.lock().unwrap_or_else(|e| e.into_inner()).push((nr, a, fertig));
    // Ein wartender Rendervorgang haelt den Faden fest; er gibt ihn frei,
    // sobald etwas ansteht (s. [`rendern`]).
    geteilt().abbrechen();
    if unsafe { PostMessageW(Some(h), fenster::WM_PULSE_ABLAGE, WPARAM(0), LPARAM(0)) }.is_err() {
        // **Den eigenen Auftrag wieder entnehmen** (Befund B6). Bliebe er
        // liegen, liefe er beim naechsten `WM_PULSE_ABLAGE` ausser der Reihe —
        // ein `Beanspruchen` oder `Freigeben` zu einem Zeitpunkt, an dem die
        // Zustandsmaschine laengst etwas anderes glaubt.
        zuruecknehmen(nr);
        eprintln!("[ablage] Auftrag nicht zustellbar — Fensterfaden nicht erreichbar.");
        return;
    }
    if warten.recv_timeout(AUFTRAG_FRIST).is_err() {
        // Dasselbe nach Fristablauf: der Auftrag KANN inzwischen gelaufen sein
        // (dann ist er weg und `zuruecknehmen` findet nichts), oder er steht
        // noch aus — und dann soll er es nicht mehr.
        zuruecknehmen(nr);
        eprintln!("[ablage] Fensterfaden antwortet nicht — Auftrag zurueckgenommen.");
    }
}

/// Einen noch nicht ausgefuehrten Auftrag aus dem Buch nehmen.
fn zuruecknehmen(nr: u64) {
    AUFTRAEGE.lock().unwrap_or_else(|e| e.into_inner()).retain(|(n, _, _)| *n != nr);
}

pub(super) fn abarbeiten(h: HWND) {
    let offen = std::mem::take(&mut *AUFTRAEGE.lock().unwrap_or_else(|e| e.into_inner()));
    for (_nr, a, fertig) in offen {
        match a {
            Auftrag::Beanspruchen => match fach::beanspruchen(h) {
                Ok(()) => geteilt().selbst_geaendert(true),
                Err(grund) => eprintln!(
                    "[ablage] Zwischenablage nicht beansprucht ({grund}) — \
                     ein Einfuegen auf dieser Maschine bleibt leer."
                ),
            },
            Auftrag::Freigeben(zurueck) => match zurueck {
                Some(text) => match fach::zurueckschreiben(h, &text) {
                    // Zurueckgeschrieben heisst: eine neue eigene Belegung mit
                    // dem gemerkten Text. Wir bleiben Eigentuemer, aber was in
                    // der Ablage liegt, gehoert wieder dem Nutzer.
                    Ok(()) => geteilt().selbst_geaendert(true),
                    Err(grund) => eprintln!(
                        "[ablage] Vorbestand nicht zurueckgeschrieben ({grund}) — \
                         die Ablage bleibt, wie sie ist."
                    ),
                },
                None => match fach::raeumen() {
                    Ok(()) => geteilt().selbst_geaendert(false),
                    Err(grund) => eprintln!("[ablage] Ablage nicht geraeumt ({grund})."),
                },
            },
            Auftrag::Lesen => {
                let text = fach::lesen(h);
                geteilt().lesen_fertig(text);
            }
        }
        let _ = fertig.send(());
    }
}
