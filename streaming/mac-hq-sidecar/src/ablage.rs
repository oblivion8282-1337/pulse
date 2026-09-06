//! Die geteilte Zwischenablage der Fernsteuerung — die Host-Haelfte auf macOS.
//!
//! **Der Mechanismus ist verzoegertes Rendern**, und er liegt vollstaendig in
//! `pulse_ablage`: beim Kopieren geht nur eine Ankuendigung hinaus, der Inhalt
//! erst, wenn drueben jemand tatsaechlich einfuegt. Auch die Umsetzung fuer
//! macOS liegt dort (`pulse_ablage::plattform::macos`) — anders als auf
//! Windows, wo sie im Sidecar steht: hier braucht sie ausser dem Sidecar auch
//! der Player (der Steuernde), und beide Haelften einer Zwischenablage sind
//! spiegelbildlich gleich.
//!
//! Diese Datei ist nur die Verdrahtung mit dem Sidecar — welcher Wert wohin,
//! wer taktet, wann Schluss ist.
//!
//! ## Ein Prozess je Platz, eine Zwischenablage je Maschine
//!
//! Wie auf Windows faehrt Electron je Stream-Platz einen eigenen
//! Sidecar-Prozess (`desktop/electron/sidecar.ts::getSidecar(slot)`), die
//! Zwischenablage ist aber maschinenweit. **Genau einer ist Traeger, gewaehlt
//! wird er im Renderer des Hosts** (`web/src/lib/remote/ablageTraeger.ts`).
//! Der Wahlspruch ist der Anstoss `beginn`: **erst er stellt den Eigner-Faden
//! auf.** Ein Sidecar, der ihn nie bekommt, ruehrt die Zwischenablage nicht an
//! und kostet nichts.
//!
//! ## Was NICHT mit dem Prozess endet — der Unterschied zu Windows
//!
//! Der Windows-Sidecar ist per-Stream und **beendet sich nach `stop`**
//! (`dispatch.rs` dort). Sein Prozessende ist damit zugleich das Ende seines
//! Eigentums an der Zwischenablage, und `beenden_endgueltig` beim Prozessende
//! genuegt.
//!
//! **Auf macOS bleibt der Prozess warm** (`dispatch.rs`, „No `exit_after`
//! flag"). Die Windows-Loesung eins zu eins zu uebernehmen hiesse: endet der
//! Traeger-Stream, laeuft dieser Prozess weiter, haelt die Zwischenablage des
//! Nutzers weiter beansprucht (also leer) und gibt sie erst frei, wenn die
//! ganze App endet. Deshalb gibt es hier **zwei** Wege, und beide werden
//! gebraucht:
//!
//! * **`stop`** ruft [`beenden`] — der Augenblick, in dem der Windows-Sidecar
//!   stirbt, nur eben ohne zu sterben. Er haengt an nichts ausser diesem
//!   Prozess und wirkt deshalb auch dann, wenn der Renderer gerade nichts
//!   mitbekommt (Chromium drosselt Zeitgeber in verdeckten Fenstern auf einen
//!   Lauf je Minute — s. `ablage.ts`).
//! * **`ende` vom Renderer** deckt den Fall ab, in dem ein Stream OHNE `stop`
//!   endet (Fehler, weggebrochene Quelle) und der Renderer einen neuen Traeger
//!   waehlt.
//!
//! Beides ist idempotent: `Ablagelage::ende` gibt frei, was noch gehalten wird,
//! und tut sonst nichts.
//!
//! [`beenden_endgueltig`] bleibt zusaetzlich am Prozessende (`main.rs`,
//! stdin-EOF) — ein hartes Ende (`kill`) deckt es weiterhin nicht ab, dafuer
//! braeuchte es einen Halter ausserhalb dieses Prozesses.

use std::sync::{Mutex, MutexGuard, OnceLock};

use pulse_ablage::format::Rahmen;
use pulse_ablage::lage::{Ablagelage, Anstoss, Entscheidung, Prozessablage, deuten};
use pulse_ablage::plattform::Ablageplattform;
use pulse_ablage::plattform::macos::{self, MacAblage};

/// Hoechstens so viele Werte warten auf den Takt-Faden.
///
/// Die Warteschlange waechst nur, wenn der Takt-Faden nicht mehr laeuft — und
/// dann ist die Zwischenablage ohnehin tot. Die Grenze ist deshalb kein
/// Durchsatzwert, sondern ein Riegel gegen unbegrenztes Wachsen: der Gateway
/// deckelt bei 60 Signalen je Sekunde, gut vier Sekunden Vorrat.
const WARTESCHLANGE_MAX: usize = 256;

/// Wie oft die Zustandsmaschine laeuft. Ein Bildtakt bei 60 Hz.
///
/// Der Takt bestimmt, wie schnell ein Einfuegen sein `hol` hinausschickt und
/// wie fein die Abruf-Frist greift; teurer ist er nicht. **Er laeuft erst ab
/// dem Anstoss `beginn`**, also nur im Traeger-Prozess.
const TAKT_MS: u64 = 16;

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

/// Zustandsmaschine, Prozess-Stand und Plattform zusammen ausleihen.
fn mit<R>(f: impl FnOnce(&mut Ablagelage, &mut Prozessablage, &mut dyn Ablageplattform) -> R) -> R {
    let mut s = stand();
    let Stand { lage, prozess } = &mut *s;
    f(lage, prozess, &mut MacAblage)
}

fn warteschlange() -> &'static Mutex<Vec<serde_json::Value>> {
    static INSTANZ: OnceLock<Mutex<Vec<serde_json::Value>>> = OnceLock::new();
    INSTANZ.get_or_init(|| Mutex::new(Vec::new()))
}

/// Ein Wert der Operation `ablage`.
///
/// **Diese Funktion arbeitet ihn NICHT ab, sie reiht ihn ein.** Sie laeuft auf
/// dem Dispatch-Faden, und auf dem liegt auch `remote_input` — die
/// Eingabe-Injektion der Fernsteuerung. Die Abarbeitung fasst die Plattform an
/// und kann dabei bis zu einer Auftrags-Frist (500 ms) auf den Eigner-Faden
/// warten; realistisch sind Mikrosekunden, aber der **Deckel** waere eine halbe
/// Sekunde stockende Eingabe. Auf Windows war genau das ein Prueffund (B9).
///
/// **Was hier bleibt, ist der Start.** `beginn` stellt den Eigner-Faden und den
/// Takt-Faden auf — vorher gibt es niemanden, der die Warteschlange leeren
/// koennte.
///
/// **Gedeutet wird in `pulse_ablage::lage::deuten`, nicht hier**, und die
/// Huelle entscheidet, nicht die Reihenfolge: fremde Nutzlast liegt immer unter
/// `rahmen`, ein Anstoss immer unter `anstoss`. Ohne diese Trennung genuegte
/// ein einziges fremdes `remote_signal`, um den Traeger zu wechseln oder die
/// Ablage abzuschalten. Der `beginn`-Blick hier ist deshalb kein zweiter
/// Parser, sondern dieselbe Funktion, einmal vorab gefragt.
pub fn verarbeiten(data: &serde_json::Value) {
    if matches!(deuten(data), Entscheidung::Anstoss(Anstoss::Beginn)) {
        if let Err(grund) = macos::starten() {
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

/// Der Takt-Faden.
///
/// **Er darf nicht der Eigner-Faden sein.** Der blockiert waehrend eines
/// `pasteboard:provideDataForType:`, und genau dann muss der Takt
/// weiterlaufen: die Abruf-Frist ist es, die dem wartenden Programm die leere
/// Antwort zustellt (`pulse_ablage::lage::takt`, Schritt 2). Ein Faden, der auf
/// sich selbst wartet, haengt — und mit ihm das einfuegende Programm.
///
/// Er endet erst mit dem Prozess. Das ist billiger, als ihn zu beenden und neu
/// aufzustellen: schlaeft die Sitzung, liefert `takt` sofort eine leere Liste.
/// **Auf macOS wiegt das schwerer als auf Windows**, weil der Prozess mehrere
/// Streams ueberlebt — ein Faden je Stream waere ein Leck.
fn takt_starten() {
    static LAEUFT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if LAEUFT.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let gebaut = std::thread::Builder::new().name("pulse-ablage-takt".into()).spawn(|| {
        loop {
            std::thread::sleep(std::time::Duration::from_millis(TAKT_MS));
            // Erst das Eingereihte, dann der Takt: ein `beginn` oder ein `neu`,
            // das gerade eintraf, soll noch in DIESEM Durchlauf wirken.
            let offen =
                std::mem::take(&mut *warteschlange().lock().unwrap_or_else(|e| e.into_inner()));
            for data in offen {
                let hinaus = mit(|lage, prozess, p| lage.anwenden(&data, prozess, p));
                melden(&hinaus);
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

/// Eigentum abgeben und den gemerkten Vorbestand zurueckschreiben — **der
/// Faden bleibt stehen.**
///
/// Gerufen aus `stop`: das ist der Augenblick, in dem der Windows-Sidecar
/// stirbt. Hier stirbt nichts, also muss das Aufraeumen von Hand geschehen.
/// Der Eigner-Faden darf dabei stehenbleiben — er kostet einen schlafenden
/// Faden, und der naechste Stream auf diesem Platz braucht ihn wieder.
///
/// **Eingereiht, nicht ausgefuehrt**, und aus demselben Grund wie bei
/// [`verarbeiten`] (Windows-Befund B9): `stop` laeuft auf dem Dispatch-Faden,
/// und auf dem liegt `remote_input`. Die Freigabe fasst die Plattform an und
/// kann dabei bis zu einer Auftrags-Frist (500 ms) auf den Eigner-Faden warten
/// — eine halbe Sekunde stockende Fremdeingabe. Der Takt-Faden erledigt es
/// hoechstens [`TAKT_MS`] spaeter, und niemand wartet darauf: anders als beim
/// Prozessende ([`beenden_endgueltig`]) laeuft hier alles weiter.
pub fn beenden() {
    if !macos::steht() {
        return;
    }
    verarbeiten(&serde_json::json!({ "anstoss": "ende" }));
}

/// **Jedes geordnete Prozessende geht hier durch** (`main.rs`, stdin-EOF):
/// Eigentum abgeben, gemerkten Vorbestand zurueckschreiben, Faden abbauen.
///
/// Ohne das stirbt der Prozess als Eigentuemer eines verzoegerten
/// Rendervorgangs, und was der Nutzer vorher kopiert hatte, ist still weg.
///
/// **Ein hartes Ende deckt das NICHT ab** (`kill`) — dieselbe Luecke wie auf
/// Windows, und ohne einen Halter ausserhalb dieses Prozesses auch nicht
/// loesbar.
pub fn beenden_endgueltig() {
    if !macos::steht() {
        return;
    }
    mit(|lage, prozess, p| lage.ende(prozess, p));
    macos::stoppen();
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
