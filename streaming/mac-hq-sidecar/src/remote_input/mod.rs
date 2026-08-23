//! Fernsteuerung, macOS-Haelfte.
//!
//! Der plattformfreie Kern (Frame-Format, Sitzungs-Zustandsmaschine,
//! Klemmrechnung, Bewegungsschwelle) liegt in `pulse-fernsteuerung` — siehe
//! `streaming/win-hq-sidecar/src/remote_input/mod.rs` fuer die erste
//! Anbindung. Hier beginnt der zweite Host mit dem einen Stueck, das nur
//! macOS kennt.
//!
//! **Der Schnitt laeuft zwischen Rechnung und Wirkung**, und zwar mit Absicht:
//! [`tasten`] (Scancode Satz 1 -> `kVK_*`), [`abbildung`] (Frame-Bestandteil ->
//! CoreGraphics-Ereignistyp, Knopfnummer, Kennzeichnung, Zeilen) und
//! [`klickzaehler`] (der wievielte Klick) sind rein und stehen in Unit-Tests;
//! [`injektion`] feuert ab und laesst sich nur an einem echten Ziel abnehmen —
//! dafuer gibt es den Pruefling `examples/probe_injektor/`.
//!
//! Derselbe Schnitt noch einmal beim Zeiger: [`zeigerform`] fragt AppKit und
//! zeichnet, [`zeigerpunkte`] rechnet um, und [`zeigermeldung`] haengt beides
//! an den Wecker der Wache, fuehrt die Buchfuehrung aus
//! `pulse-fernsteuerung` und traegt den Rueckfall („der Host-Zeiger reitet im
//! Bild mit"), den es auf Windows nicht gibt.
//!
//! [`wache`] steht auf derselben Seite wie [`injektion`]: sie haengt an einem
//! systemweiten Ereignis-Abgriff und stellt im Testbau keinen auf. Was an ihr
//! rein ist — die Bewegungsschwelle, die Fristrechnung — liegt schon in
//! `pulse-fernsteuerung` und wird dort geprueft; ihre Wirkung am echten System
//! belegt `examples/probe_wache.rs` (samt Gegenprobe, denn eine Wache, die
//! nichts sieht, ist ebenso still wie eine, die richtig filtert).

pub mod abbildung;
pub mod injektion;
pub mod klickzaehler;
pub mod tasten;
pub mod wache;
pub mod zeigerform;
mod zeigermeldung;
mod zeigerpunkte;
pub mod ziel;

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

use pulse_fernsteuerung::druck::Druck;
use pulse_fernsteuerung::plattform::{Injektor, Umgebung, Wache, Zielsuche};
use pulse_fernsteuerung::sitzung::Sitzung;

/// Der Injektor dieses Prozesses.
///
/// **`None` ist der Fall, den Windows nicht kennt:** dort ist der Injektor ein
/// ZST und kann gar nicht scheitern, hier braucht er eine `CGEventSource`.
/// Gibt CoreGraphics keine her, kann dieser Prozess die Zusage nicht halten —
/// abgefangen wird das beim Handschlag (s. [`MacHandschlagWache`]), nicht bei
/// jedem einzelnen Ereignis.
fn injektor() -> Option<&'static injektion::MacInjektor> {
    static I: OnceLock<Option<injektion::MacInjektor>> = OnceLock::new();
    I.get_or_init(|| match injektion::MacInjektor::neu() {
        Ok(i) => Some(i),
        Err(e) => {
            eprintln!("[remote-input] Injektor nicht baubar: {e}");
            None
        }
    })
    .as_ref()
}

/// Reicht an den echten Injektor durch, sobald es einen gibt.
///
/// Der Umweg existiert nur, weil `Sitzung::neu` eine `&'static`-Referenz will
/// und `MacInjektor::neu` fehlschlagen kann. Ohne Injektor tut hier nichts —
/// **und das ist kein stiller Rueckfall**, weil der Handschlag diesen Zustand
/// schon abgelehnt hat.
struct Halter;
static HALTER: Halter = Halter;

impl Injektor for Halter {
    fn maus_setzen(&self, punkt: (i32, i32), gedrueckt: &Druck) {
        if let Some(i) = injektor() {
            i.maus_setzen(punkt, gedrueckt);
        }
    }

    fn maus_knopf(&self, btn: u8, down: bool) {
        if let Some(i) = injektor() {
            i.maus_knopf(btn, down);
        }
    }

    fn maus_rad(&self, dv: i16, dh: i16) {
        if let Some(i) = injektor() {
            i.maus_rad(dv, dh);
        }
    }

    fn taste(&self, scan: u16, down: bool, gedrueckt: &Druck) {
        if let Some(i) = injektor() {
            i.taste(scan, down, gedrueckt);
        }
    }
}

/// Die Wache samt der einen Vorbedingung, die sie selbst nicht kennt.
///
/// **Dieselbe Linie wie bei HDR und beim fehlenden Abgriff:** unerfuellbar
/// heisst Startverweigerung, nicht still etwas Schwaecheres. Eine Sitzung mit
/// Wache, aber ohne Injektor saehe fuer den Host aus wie eine laufende
/// Uebernahme, bei der der Steuernde nichts bewirkt — der Fehler wuerde dann in
/// der Leitung gesucht.
struct MacHandschlagWache(wache::MacWache);

impl Wache for MacHandschlagWache {
    fn starten(&self) -> Result<(), String> {
        if injektor().is_none() {
            return Err("kein Injektor — CGEventSourceCreate lieferte nichts".to_string());
        }
        self.0.starten()
    }

    fn stoppen(&self) {
        self.0.stoppen();
    }

    fn host_regt_sich(&self) -> bool {
        self.0.host_regt_sich()
    }

    fn rest_ms(&self) -> u64 {
        self.0.rest_ms()
    }
}

fn hueterin() -> &'static MacHandschlagWache {
    static W: OnceLock<MacHandschlagWache> = OnceLock::new();
    // Der Rueckruf ruft `sitzung()`, und `sitzung()` baut diese Wache — ein
    // Zyklus ist das nicht: gebaut wird hier nur der Verschluss, gerufen wird er
    // erst vom Wecker, und der laeuft erst nach dem Handschlag.
    W.get_or_init(|| {
        MacHandschlagWache(wache::MacWache::neu(|| {
            sitzung().vorrang_tick();
            // Auf demselben Wecker, weil dieselbe Bedingung gilt: er laeuft
            // genau, solange eine Fernsteuerung laeuft. Die Abfrage der
            // Zeigerform kostet gemessene 0,16 bis 0,18 ms und darf deshalb
            // keinen eigenen Faden bekommen (s. `zeigerform`). Gleiche
            // Anbindung wie auf Windows (`win-hq-sidecar/src/remote_input/
            // wache.rs::wecker_starten`).
            zeigermeldung::tick();
        }))
    })
}

/// Laeuft gerade eine Fernsteuerung? Der Aufnahme-Takt darf sich daran haengen.
///
/// **Zwei Leser.** Der Sendetakt — seit dem 2026-08-24 versendet der
/// `stream_controller` waehrend einer Fernsteuerung bei Ankunft statt im
/// Tick-Raster, gleichgezogen mit dem Windows-Zwilling (dort seit dem
/// 2026-08-13) — und die Zeiger-Meldung mit ihrem zweiten Blick nach dem
/// Fuehrungswechsel (`zeigermeldung`). Der Merker war frueher da als seine
/// mac-seitigen Verbraucher, weil der Vertrag ihn verlangt: „ein Feld, das
/// erst mit seinem Verbraucher entsteht, wird beim Bauen des Verbrauchers
/// vergessen."
static FERN_AKTIV: AtomicBool = AtomicBool::new(false);

pub fn fern_aktiv() -> bool {
    FERN_AKTIV.load(Ordering::Relaxed)
}

struct MacUmgebung;
static UMGEBUNG: MacUmgebung = MacUmgebung;

impl Umgebung for MacUmgebung {
    fn ziel(&self, slot: u64) -> Zielsuche {
        // Ohne Umformung: `ziel::ziel_fuer_slot` liefert bereits die Sorte der
        // Kiste. Auf Windows steht hier eine Uebersetzung, weil dort eine
        // plattformeigene `Zielsuche` mit Fenster-Handles daneben lebt.
        ziel::ziel_fuer_slot(slot)
    }

    fn host_zeiger_zeigen(&self, zeigen: bool) {
        // **Seit dem 2026-08-23 NICHT mehr wortgleich mit dem Zwilling**, und
        // der Grund steht in `zeigermeldung`: auf macOS kann der Rueckfall
        // verlangen, dass der Host-Zeiger im Bild bleibt, obwohl das
        // Cursor-Echo ihn heraushaben will. Griffen beide unabhaengig auf
        // `capture::cursorsteuerung` zu, kaempften sie gegeneinander. Die eine
        // Regel steht deshalb dort, wo beide Wuensche zusammenkommen — und
        // nicht hier.
        zeigermeldung::zeiger_der_sitzung(zeigen);
    }

    fn sitzung_beendet(&self) {
        // Die gemeldete Zeigerform und der Rueckfall gehoeren der Sitzung, die
        // gerade endet — die naechste beginnt mit leerem Buch (Begruendung in
        // `zeigermeldung::zuruecksetzen`). Ausdruecklich hier und nicht an
        // `host_zeiger_zeigen`: dort liefe es zusaetzlich bei jedem
        // Fuehrungswechsel und bei jedem Vorrang-Uebergang, und der Sidecar
        // hielte danach jede Form fuer unbekannt und schickte sie erneut.
        zeigermeldung::zuruecksetzen();
    }

    fn fern_aktiv_setzen(&self, aktiv: bool) {
        FERN_AKTIV.store(aktiv, Ordering::Relaxed);
    }

    fn vorrang_melden(&self, gilt: bool, hold_ms: u64) {
        crate::events::emit(serde_json::json!({
            "ev": "remote_state",
            "state": if gilt { "host_active" } else { "live" },
            "hold_ms": hold_ms,
        }));
    }

    fn fehler_melden(&self, grund: &str) {
        crate::events::emit(serde_json::json!({
            "ev": "remote_state",
            "state": "input_error",
            "reason": grund,
        }));
    }
}

/// Die eine Sitzung dieses Prozesses.
pub fn sitzung() -> &'static Sitzung {
    static INSTANZ: OnceLock<Sitzung> = OnceLock::new();
    INSTANZ.get_or_init(|| Sitzung::neu(&HALTER, hueterin(), &UMGEBUNG))
}

/// Pruefstand-Sperre fuer Tests, die am **prozessweiten** Zustand haengen: der
/// einen [`sitzung()`] und der Stromregistrierung in [`ziel`].
///
/// `cargo test` faehrt auf mehreren Faeden; ohne Reihenfolge legt der eine die
/// Sitzung stll, waehrend der andere „laeuft weiter" nachweist. Beim Nehmen wird
/// gleich aufgeraeumt, damit kein Test die Hinterlassenschaft eines anderen
/// sieht; eine vergiftete Sperre wird uebernommen, sonst scheiterten danach alle
/// uebrigen an ihr statt an ihrer eigenen Sache.
#[cfg(test)]
pub(crate) fn pruefstand() -> std::sync::MutexGuard<'static, ()> {
    static SPERRE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let sperre = SPERRE.lock().unwrap_or_else(|e| e.into_inner());
    ziel::strom_beendet();
    sitzung().beenden();
    sperre
}
