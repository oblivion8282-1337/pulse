//! Die geteilte Zwischenablage der Fernsteuerung — die Host-Haelfte auf
//! Windows.
//!
//! **Der Mechanismus ist verzoegertes Rendern** und liegt vollstaendig in
//! `pulse_ablage`: beim Kopieren geht nur eine Ankuendigung hinaus, der Inhalt
//! erst, wenn drueben jemand tatsaechlich einfuegt. Diese Datei verdrahtet ihn
//! mit dem Sidecar — welcher Rahmen wohin, wer taktet, wann Schluss ist.
//!
//! **Was hier NICHT liegt, und das ist der groessere Teil:** die
//! Zustandsfuehrung (`pulse_ablage::lage`, 27 Tests) und die Buchfuehrung
//! ueber eigene und fremde Aenderungen (`pulse_ablage::stand`, 6 Tests) —
//! beides plattformfrei und in jedem Gate gefahren, das diese Kiste anfasst.
//! Hier bleiben der Faden samt Nachrichtenfenster ([`fenster`]), die
//! Win32-Vorgaenge auf dem Fach selbst ([`fach`]), die Trait-Umsetzung
//! ([`quelle`]) und die Verdrahtung.
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
//! des Nutzers verschwindet, laeuft [`beenden_endgueltig`] an jedem
//! **geordneten** Prozessende (`main.rs`, beide Wege: `stop`-Op und
//! stdin-EOF): Eigentum abgeben, gemerkten Inhalt zurueckschreiben. Der
//! Renderer waehlt danach einen neuen Traeger.
//!
//! **Ein hartes Ende deckt das NICHT ab**, und diese Einschraenkung ist
//! tragend: `desktop/electron/sidecar.ts` eskaliert nach zwei Sekunden auf
//! `kill('SIGKILL')`, was auf Windows ein `TerminateProcess` ist — danach
//! laeuft hier nichts mehr, und die Ablage des Nutzers bleibt leer. Ungeloest;
//! ohne einen zweiten Halter ausserhalb dieses Prozesses auch nicht loesbar.

mod auftragsbuch;
mod fach;
mod fenster;
mod quelle;

use std::sync::{Mutex, MutexGuard, OnceLock};

use pulse_ablage::format::Rahmen;
use pulse_ablage::lage::{Ablagelage, Anstoss, Entscheidung, Prozessablage, deuten};
use pulse_ablage::plattform::Ablageplattform;

use quelle::WinAblage;

/// Hoechstens so viele Werte warten auf den Takt-Faden.
///
/// Die Warteschlange waechst nur, wenn der Takt-Faden nicht mehr laeuft — und
/// dann ist die Zwischenablage ohnehin tot. Die Grenze ist deshalb kein
/// Durchsatzwert, sondern ein Riegel gegen unbegrenztes Wachsen: der Gateway
/// deckelt bei 60 Signalen je Sekunde, gut vier Sekunden Vorrat.
const WARTESCHLANGE_MAX: usize = 256;

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
/// **Diese Funktion arbeitet ihn NICHT ab, sie reiht ihn ein.** Sie laeuft auf
/// dem Dispatch-Faden, und auf dem liegt auch `remote_input` — die
/// Eingabe-Injektion der Fernsteuerung. Die Abarbeitung fasst die Plattform an
/// und kann dabei bis zu `auftragsbuch::AUFTRAG_FRIST` (500 ms) auf den
/// Fensterfaden warten; realistisch sind Mikrosekunden, aber der **Deckel**
/// waere eine halbe Sekunde stockende Eingabe. Der Entwurf verbietet dem
/// blockierenden Rueckruf den Injektionsfaden ausdruecklich; diese Operation
/// hing bis zum Prueflauf von 1b-2 trotzdem daran (Befund B9). Sie tut es
/// nicht mehr: gedeutet und beantwortet wird auf dem Takt-Faden, und der
/// naechste Takt ist hoechstens [`TAKT_MS`] entfernt.
///
/// **Was hier bleibt, ist der Start.** `beginn` stellt den Fensterfaden und
/// den Takt-Faden auf — vorher gibt es niemanden, der die Warteschlange
/// leeren koennte. Das kostet einen Fenster-Aufbau, keine Zwischenablage-
/// Sperre.
///
/// **Gedeutet wird in `pulse_ablage::lage::deuten`, nicht hier**, und die
/// Huelle entscheidet, nicht die Reihenfolge: fremde Nutzlast liegt immer unter
/// `rahmen`, ein Anstoss immer unter `anstoss`. Ohne diese Trennung genuegte
/// ein einziges fremdes `remote_signal`, um den Traeger zu wechseln oder die
/// Ablage abzuschalten. **Der `beginn`-Blick hier ist deshalb kein zweiter
/// Parser**, sondern dieselbe Funktion, einmal vorab gefragt.
pub fn verarbeiten(data: &serde_json::Value) {
    if matches!(deuten(data), Entscheidung::Anstoss(Anstoss::Beginn)) {
        if let Err(grund) = fenster::starten() {
            eprintln!(
                "[ablage] Zwischenablage nicht verfuegbar ({grund}) — \
                 auf dieser Maschine wird nichts geteilt."
            );
        }
        takt_starten();
    }
    let mut warten = warteschlange().lock().unwrap_or_else(|e| e.into_inner());
    if warten.len() >= WARTESCHLANGE_MAX {
        // Nur erreichbar, wenn der Takt-Faden weg ist. Der aelteste faellt:
        // was hier wartet, sind zum grossen Teil Ankuendigungen, und eine
        // neuere macht die aeltere gegenstandslos.
        warten.remove(0);
    }
    warten.push(data.clone());
}

fn warteschlange() -> &'static Mutex<Vec<serde_json::Value>> {
    static INSTANZ: OnceLock<Mutex<Vec<serde_json::Value>>> = OnceLock::new();
    INSTANZ.get_or_init(|| Mutex::new(Vec::new()))
}

/// Einen eingereihten Wert abarbeiten — **nur vom Takt-Faden gerufen.**
///
/// Die Zuordnung „Entscheidung → Wirkung" steht seit dem 2026-08-31 in
/// `pulse_ablage::lage::anwenden` und nicht mehr hier: sie war Zeile fuer Zeile
/// dieselbe wie im Player, und mit dem macOS-Host waere sie ein drittes Mal
/// abgeschrieben worden. Was hier bleibt, ist der Weg der Antwort.
fn abarbeiten(data: &serde_json::Value) {
    let hinaus = mit(|lage, prozess, p| lage.anwenden(data, prozess, p));
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
            // Erst das Eingereihte, dann der Takt: ein `beginn` oder ein
            // `neu`, das gerade eintraf, soll noch in DIESEM Durchlauf wirken.
            let offen = std::mem::take(
                &mut *warteschlange().lock().unwrap_or_else(|e| e.into_inner()),
            );
            for data in offen {
                abarbeiten(&data);
            }
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
