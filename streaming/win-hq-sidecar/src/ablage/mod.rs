//! Die geteilte Zwischenablage der Fernsteuerung — die Host-Haelfte auf
//! Windows.
//!
//! **Der Mechanismus ist verzoegertes Rendern** und liegt vollstaendig in
//! `pulse_ablage`: beim Kopieren geht nur eine Ankuendigung hinaus, der Inhalt
//! erst, wenn drueben jemand tatsaechlich einfuegt. Diese Datei verdrahtet ihn
//! mit dem Sidecar — welcher Rahmen wohin, wer taktet, wann Schluss ist.
//!
//! **Vier Teile:** die Zustandsfuehrung kommt aus der Kiste
//! (`pulse_ablage::lage`, dort gepruefte 80 Tests), die Buchfuehrung ueber
//! eigene und fremde Aenderungen steht in [`geteilt`] (pruefbar, ohne Win32),
//! der Faden samt Nachrichtenfenster in [`fenster`], die Win32-Vorgaenge auf
//! dem Fach selbst in [`fach`]. Hier steht nur die Verdrahtung.
//!
//! ## Ein Prozess je Platz, eine Zwischenablage je Maschine
//!
//! Windows faehrt je Stream-Platz einen eigenen Sidecar-Prozess
//! (`desktop/electron/sidecar.ts::getSidecar(slot)`), die Zwischenablage ist
//! aber maschinenweit. Beanspruchten alle, ueberschrieben sie sich gegenseitig.
//! **Genau einer ist Traeger, und gewaehlt wird er im Renderer des Hosts**
//! (`web/src/lib/remote/ablageTraeger.ts`) — dieselbe Aufloesung wie beim
//! Vorrang, wo die Wache ebenfalls je Prozess sitzt und nur der Renderer alle
//! Plaetze kennt.
//!
//! Der Wahlspruch ist der Anstoss `beginn`: **erst er stellt den Fensterfaden
//! auf.** Ein Sidecar, der ihn nie bekommt, ruehrt die Zwischenablage nicht
//! an und kostet nichts — kein Fenster, kein Faden, keine Beobachtung.
//!
//! ## Was mit dem Prozess endet
//!
//! Der Windows-Sidecar ist per-Stream und beendet sich nach `stop`
//! (`dispatch.rs`). Endet der Traeger-Stream, endet dieser Prozess — und mit
//! ihm das Eigentum an der Zwischenablage. Damit dabei nicht der Vorbestand
//! des Nutzers verschwindet, laeuft [`beenden_endgueltig`] an **jedem**
//! Prozessende (`main.rs`, beide Wege): Eigentum abgeben, gemerkten Inhalt
//! zurueckschreiben. Der Renderer waehlt danach einen neuen Traeger.

mod fach;
mod fenster;
mod geteilt;
mod quelle;

use std::sync::{Mutex, MutexGuard, OnceLock};

use pulse_ablage::format::Rahmen;
use pulse_ablage::lage::{Ablagelage, Anstoss, Entscheidung, Prozessablage, deuten};
use pulse_ablage::plattform::Ablageplattform;

use quelle::WinAblage;

/// Wie oft die Zustandsmaschine laeuft.
///
/// Ein Bildtakt bei 60 Hz. Der Takt bestimmt, wie schnell ein Einfuegen sein
/// `hol` hinausschickt und wie fein die Abruf-Frist greift; teurer ist er
/// nicht — er wacht auf, fragt drei Merker ab und schlaeft weiter. **Er laeuft
/// erst ab dem Anstoss `beginn`**, also nur im Traeger-Prozess.
const TAKT_MS: u64 = 16;

/// Zustandsmaschine und Prozess-Stand dieses Sidecars.
struct Stand {
    lage: Ablagelage,
    prozess: Prozessablage,
}

fn stand() -> MutexGuard<'static, Stand> {
    static INSTANZ: OnceLock<Mutex<Stand>> = OnceLock::new();
    INSTANZ
        .get_or_init(|| {
            Mutex::new(Stand { lage: Ablagelage::default(), prozess: Prozessablage::default() })
        })
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// Zustandsmaschine, Prozess-Stand und Plattform zusammen ausleihen — die eine
/// Stelle, an der die drei aufeinandertreffen.
fn mit<R>(f: impl FnOnce(&mut Ablagelage, &mut Prozessablage, &mut dyn Ablageplattform) -> R) -> R {
    let mut s = stand();
    let Stand { lage, prozess } = &mut *s;
    f(lage, prozess, &mut WinAblage)
}

/// Ein Wert der Operation `ablage` — entweder ein Rahmen der Gegenseite oder
/// ein Anstoss des eigenen Renderers.
///
/// **Gedeutet wird in `pulse_ablage::lage::deuten`, nicht hier**, und die
/// Huelle entscheidet, nicht die Reihenfolge: fremde Nutzlast liegt immer unter
/// `rahmen`, ein Anstoss immer unter `anstoss`. Ohne diese Trennung genuegte
/// ein einziges fremdes `remote_signal`, um den Traeger zu wechseln oder die
/// Ablage abzuschalten.
pub fn verarbeiten(data: &serde_json::Value) {
    let entscheidung = deuten(data);
    // **Der Fensterfaden wird VOR der Sperre aufgestellt**: er ist die Antwort
    // auf `beginn`, und wer ihn erst danach aufstellte, liesse den ersten Takt
    // gegen eine Plattform laufen, die es noch nicht gibt.
    if matches!(entscheidung, Entscheidung::Anstoss(Anstoss::Beginn)) {
        if let Err(grund) = fenster::starten() {
            eprintln!(
                "[ablage] Zwischenablage nicht verfuegbar ({grund}) — \
                 auf dieser Maschine wird nichts geteilt."
            );
        }
        takt_starten();
    }
    let hinaus = mit(|lage, prozess, p| match entscheidung {
        Entscheidung::Anstoss(Anstoss::Beginn) => {
            lage.beginnen();
            Vec::new()
        }
        Entscheidung::Anstoss(Anstoss::NeuBitte) => lage.neu_bitte(),
        Entscheidung::Anstoss(Anstoss::Ende) => {
            lage.ende(prozess, p);
            Vec::new()
        }
        Entscheidung::Fern(r) => lage.fern(&r, p),
        Entscheidung::Verwerfen => Vec::new(),
    });
    melden(&hinaus);
}

/// Der Takt-Faden.
///
/// **Er darf nicht der Fensterfaden sein.** Der blockiert waehrend eines
/// `WM_RENDERFORMAT`, und genau dann muss der Takt weiterlaufen: die
/// Abruf-Frist ist es, die dem wartenden Programm die leere Antwort zustellt
/// (`pulse_ablage::lage::takt`, Schritt 2). Ein Faden, der auf sich selbst
/// wartet, haengt — und mit ihm das einfuegende Programm.
///
/// Er endet erst mit dem Prozess. Das ist billiger, als ihn zu beenden und neu
/// aufzustellen: schlaeft die Sitzung, liefert `takt` sofort eine leere Liste.
fn takt_starten() {
    static LAEUFT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if LAEUFT.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let gebaut = std::thread::Builder::new().name("pulse-ablage-takt".into()).spawn(|| {
        loop {
            std::thread::sleep(std::time::Duration::from_millis(TAKT_MS));
            let hinaus = mit(|lage, prozess, p| lage.takt(prozess, p));
            melden(&hinaus);
        }
    });
    if let Err(e) = gebaut {
        LAEUFT.store(false, std::sync::atomic::Ordering::SeqCst);
        eprintln!(
            "[ablage] Takt-Faden nicht startbar ({e}) — die Zwischenablage \
             kuendigt nichts an und beantwortet nichts."
        );
    }
}

/// **Jedes Prozessende geht hier durch** (`main.rs`, beide Wege): Eigentum
/// abgeben und den gemerkten Vorbestand zurueckschreiben.
///
/// Ohne das kostete ein endender Stream den Nutzer seine Zwischenablage: der
/// Prozess stirbt als Eigentuemer eines verzoegerten Rendervorgangs, Windows
/// haelt danach ein leeres Fach, und was der Nutzer vor der Sitzung kopiert
/// hatte, ist still weg. Genau der Schaden, gegen den der Vorbestand gebaut
/// ist.
pub fn beenden_endgueltig() {
    if !fenster::steht() {
        return;
    }
    mit(|lage, prozess, p| lage.ende(prozess, p));
    fenster::stoppen();
}

/// Was hinausgeht, geht als Ereignis an Electron — von dort weiter an den
/// Renderer und ueber `remote_signal` zur Gegenseite.
///
/// **Ohne Sitzungsnummer**: die Zwischenablage gehoert der Maschine, nicht
/// einem Stream-Platz. Welchen Platz ein Ereignis verlaesst, haengt Electron
/// selbst an (`main.ts`, `{...ev, slot}`) — der Renderer braucht es, um
/// Ereignisse eines Prozesses zu verwerfen, der nicht Traeger ist.
fn melden(hinaus: &[Rahmen]) {
    for r in hinaus {
        crate::events::emit(serde_json::json!({ "ev": "ablage", "data": r.nach_json() }));
    }
}
