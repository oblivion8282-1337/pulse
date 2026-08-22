//! Fernsteuerung, Windows-Haelfte.
//!
//! Der Kern liegt seit dem 2026-08-22 gemeinsam in `pulse-fernsteuerung`:
//! Frame-Format, Sitzungs-Zustandsmaschine, Klemmrechnung, Bewegungsschwelle,
//! Ausfuehrung. **Nicht wieder hierher zurueckkopieren** — „synchron halten"
//! ist die falsche Anweisung, die Dateien existieren nur noch einmal.
//!
//! Was hier bleibt, kennt Windows: [`injektion`] (`SendInput`, die eigene
//! Marke, das DPI-Bewusstsein), [`wache`] (die Low-Level-Haken samt Faden und
//! Wecker), [`ziel`] (Slot → Aufnahmequelle → Rechteck), [`zuordnung`] (die
//! Normierung auf den virtuellen Desktop) und [`zeigerform`] samt
//! [`zeigerpixel`]/[`zeigerpunkte`].

pub mod injektion;
pub mod wache;
mod zeigerform;
mod zeigerpixel;
mod zeigerpunkte;
pub mod ziel;
pub mod zuordnung;

use pulse_fernsteuerung::druck::Druck;
// `Zielsuche` heisst hier UND in `ziel` so — der Kern kennt das Ergebnis, das
// Windows-Modul den Weg dorthin. Umbenannt statt eines der beiden zu
// verschieben: `ziel::Zielsuche` traegt eine Windows-`Bindung`, die im Kern
// nichts zu suchen hat.
use pulse_fernsteuerung::plattform::{Injektor, Umgebung, Wache, Zielsuche as KernZiel};
use pulse_fernsteuerung::sitzung::Sitzung;
use pulse_fernsteuerung::zuordnung::Rechteck;

pub use pulse_fernsteuerung::sitzung::Bericht;

/// Laeuft gerade eine Fernsteuerung? Fuer den Pacing-Loop (`pipeline_hw`).
///
/// Atomar statt ueber die Sitzungssperre, weil der Pacing-Loop das bis zu
/// 60-mal je Sekunde liest und dafuer nicht die Eingabe-Sperre anfassen soll.
static FERN_AKTIV: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn fern_aktiv() -> bool {
    FERN_AKTIV.load(std::sync::atomic::Ordering::Relaxed)
}

struct WinInjektor;
struct WinWache;
struct WinUmgebung;

static INJEKTOR: WinInjektor = WinInjektor;
static WACHE: WinWache = WinWache;
static UMGEBUNG: WinUmgebung = WinUmgebung;

/// Die eine Sitzung dieses Prozesses.
pub fn sitzung() -> &'static Sitzung {
    static INSTANZ: std::sync::OnceLock<Sitzung> = std::sync::OnceLock::new();
    INSTANZ.get_or_init(|| Sitzung::neu(&INJEKTOR, &WACHE, &UMGEBUNG))
}

impl Injektor for WinInjektor {
    fn maus_setzen(&self, punkt: (i32, i32), _gedrueckt: &Druck) {
        // Windows braucht die Gedrueckt-Menge nicht: eine absolute Bewegung
        // waehrend eines Knopfdrucks zieht dort von selbst. Auf macOS ist das
        // ein eigener Ereignistyp — deshalb steht sie im Trait.
        let vd = zuordnung::virtueller_desktop();
        let (nx, ny) = zuordnung::punkt_auf_absolut(punkt.0, punkt.1, &vd);
        injektion::maus(
            nx,
            ny,
            0,
            windows::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_MOVE
                | windows::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_ABSOLUTE
                | windows::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_VIRTUALDESK,
        );
    }

    fn maus_knopf(&self, btn: u8, down: bool) {
        // `btn` ist gegen `format::knopf_bekannt` geprueft — `None` ist
        // unerreichbar, und still nichts zu tun ist hier richtiger als eine
        // Panik im Dispatch-Faden.
        if let Some((flag, daten)) = injektion::tasten_ereignis(btn, down) {
            injektion::maus(0, 0, daten, flag);
        }
    }

    fn maus_rad(&self, dv: i16, dh: i16) {
        use windows::Win32::UI::Input::KeyboardAndMouse::{MOUSEEVENTF_HWHEEL, MOUSEEVENTF_WHEEL};
        // Zwei Aufrufe, weil Windows je Achse ein eigenes Ereignis verlangt.
        // Der Kern schickt beides in einem Aufruf; die Aufteilung ist eine
        // Windows-Eigenheit und gehoert deshalb hierher.
        if dv != 0 {
            injektion::maus(0, 0, dv as i32, MOUSEEVENTF_WHEEL);
        }
        if dh != 0 {
            injektion::maus(0, 0, dh as i32, MOUSEEVENTF_HWHEEL);
        }
    }

    fn taste(&self, scan: u16, down: bool) {
        injektion::taste(scan, down);
    }
}

impl Wache for WinWache {
    fn starten(&self) -> Result<(), String> {
        wache::starten()
    }
    fn stoppen(&self) {
        wache::stoppen();
    }
    fn host_regt_sich(&self) -> bool {
        wache::host_regt_sich()
    }
    fn rest_ms(&self) -> u64 {
        wache::rest_ms()
    }
}

impl Umgebung for WinUmgebung {
    fn ziel(&self, slot: u64) -> KernZiel {
        match ziel::bindung_fuer_slot(slot) {
            ziel::Zielsuche::Gefunden(b) => KernZiel::Gefunden {
                rechteck: b.ziel.screen_rect().map(|r| Rechteck {
                    links: r.left,
                    oben: r.top,
                    rechts: r.right,
                    unten: r.bottom,
                }),
                sichtbar: !b.wacht.is_some_and(|w| !w.is_source_visible()),
            },
            ziel::Zielsuche::KeinStrom => KernZiel::KeinStrom,
            ziel::Zielsuche::NichtAufloesbar(g) => KernZiel::NichtAufloesbar(g),
        }
    }

    fn host_zeiger_zeigen(&self, zeigen: bool) {
        if zeigen {
            crate::capture::cursorsteuerung::zeigen();
        } else {
            crate::capture::cursorsteuerung::verbergen();
        }
    }

    fn sitzung_beendet(&self) {
        // Die gemeldete Zeigerform gehoert der Sitzung, die gerade endet — die
        // naechste beginnt mit leerem Merker. Genau wie vorher: nur hier, nicht
        // bei jedem Zeigerwechsel.
        zeigerform::zuruecksetzen();
    }

    fn fern_aktiv_setzen(&self, aktiv: bool) {
        FERN_AKTIV.store(aktiv, std::sync::atomic::Ordering::Relaxed);
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
