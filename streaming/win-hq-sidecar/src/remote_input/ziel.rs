//! Slot → Aufnahmequelle → Quell-Rechteck.
//!
//! ## Wie Slots hier stehen
//!
//! Ein `slot` benennt **einen der gleichzeitig laufenden Streams des Hosts**,
//! nicht einen Monitor (Spezifikation, Abschnitt „Der `slot`"). Auf Windows
//! werden diese Streams **prozessweise** getrennt: `desktop/electron/sidecar.ts`
//! fährt je Platz einen eigenen Sidecar (`getSidecar(slot)`), und innerhalb
//! eines Prozesses gibt es genau einen Stream — den des
//! [`crate::stream_controller::StreamController`]-Singletons. Electron leitet
//! `remote_input` also schon an den richtigen Prozess.
//!
//! Deshalb die Auflösung hier in zwei Regeln:
//!
//! * Der laufende Stream **nennt seinen Platz** (`slot` in der `start`-Anfrage)
//!   → er nimmt nur Frames dieses Platzes an. Ein an den falschen Prozess
//!   geratener Klick landet dann nicht auf dem falschen Bildschirm.
//! * Der laufende Stream **nennt ihn nicht** (heutiger Regelfall, Electron
//!   schickt das Feld nicht) → er ist der einzige des Prozesses und trägt jeden
//!   Platz. Sonst verschwände die Fernsteuerung wortlos, sobald ein Steuernder
//!   `slot: 1` schickt.
//!
//! Kein passender Stream heißt **unbekannter Slot**: die Frames werden still
//! verworfen und die Sitzung bleibt stehen. Das ist die eine Abweichung von
//! fail-closed, und sie hat einen Grund — Streams enden asynchron, ein Slot kann
//! zwischen Absenden und Ankunft verschwinden. Das ist ein Rennen, kein Angriff.
//!
//! ## Das Rechteck
//!
//! Es wird **zur Injektionszeit** gelesen, nicht beim Sitzungsstart: Fenster
//! bewegen sich. Gehalten wird nur der Handle (`InjectTarget`), aus dem sich das
//! Rechteck jedes Mal frisch ergibt.

use std::sync::Mutex;

use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, HMONITOR, MONITORINFO};
use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
use windows_capture::monitor::Monitor;

use crate::capture::source::{CaptureSource, ResolvedTarget, SourceGuard};

/// Labor-Schalter: Injektion **ohne laufenden Stream**, Quell-Rechteck = primärer
/// Bildschirm.
///
/// **Wozu.** Das Prüfziel misst, ob eine gesendete Koordinate am Host auf dem
/// Punkt ankommt (`streaming/win-hq-labor/testbench/eingabe-pruefziel.ps1`).
/// Dafür einen echten Bildschirm-Push aufzubauen hieße, zwei Dinge gleichzeitig
/// zu prüfen und beim Fehlschlag nicht zu wissen, welches.
///
/// **Kein Produktweg.** Standardmäßig aus. Angeschaltet nimmt die Injektion ein
/// Rechteck an, das mit keiner Aufnahme belegt ist — die Kopplung „du kannst nur
/// dorthin klicken, wo du auch hinsiehst" fällt damit weg. Nichts im
/// ausgelieferten Pfad setzt die Variable.
const LABOR_OHNE_STROM: &str = "PULSE_LABOR_EINGABE_OHNE_STREAM";

/// Der laufende Stream dieses Prozesses, für die Fernsteuerung sichtbar.
/// Gesetzt beim `start`, geleert wenn der Worker endet.
static AKTIVER_STROM: Mutex<Option<AktiverStrom>> = Mutex::new(None);

struct AktiverStrom {
    /// Der erklärte Platz — `None` = nicht genannt (s. Modul-Doku).
    slot: Option<u32>,
    quelle: CaptureSource,
}

/// Trägt ein Stream mit diesem erklärten Platz den angefragten? Die beiden
/// Regeln aus der Modul-Doku: der erklärte Platz gilt strikt, der ungenannte
/// trägt jeden.
fn traegt_slot(erklaert: Option<u32>, angefragt: u32) -> bool {
    erklaert.is_none() || erklaert == Some(angefragt)
}

/// Vom [`crate::stream_controller`] beim Start gerufen.
pub fn strom_gestartet(slot: Option<u32>, quelle: CaptureSource) {
    *AKTIVER_STROM.lock().unwrap() = Some(AktiverStrom { slot, quelle });
}

/// Vom [`crate::stream_controller`] gerufen, wenn der Worker endet.
pub fn strom_beendet() {
    *AKTIVER_STROM.lock().unwrap() = None;
}

/// Was die Auflösung eines Slots ergeben hat.
pub enum Zielsuche {
    Gefunden(Bindung),
    /// Kein Stream auf diesem Platz → still verwerfen, Sitzung bleibt stehen.
    KeinStrom,
    /// Stream da, Quelle aber nicht auflösbar (Fenster zu, Bildschirm
    /// abgesteckt) → auch verwerfen, aber mit Begründung in der Diagnose.
    NichtAufloesbar(String),
}

/// Die Bindung an eine Aufnahmequelle: woraus das Rechteck kommt und ob gerade
/// überhaupt etwas zu sehen ist.
pub struct Bindung {
    pub ziel: InjectTarget,
    /// Sichtschutz (nur beim Fenster→Bildschirm-Rückfall gesetzt): schwärzt er,
    /// sieht der Steuernde Schwarzbild und darf nicht blind klicken.
    pub wacht: Option<SourceGuard>,
}

/// Slot auflösen. Nimmt **jedes Mal** die aktuelle Lage — der Aufrufer darf das
/// Ergebnis für die Dauer einer Nachricht halten, nicht für die Sitzung.
pub fn bindung_fuer_slot(slot: u32) -> Zielsuche {
    let quelle = {
        let reg = AKTIVER_STROM.lock().unwrap();
        reg.as_ref()
            .filter(|s| traegt_slot(s.slot, slot))
            .map(|s| s.quelle.clone())
    };
    let Some(quelle) = quelle else {
        return labor_rueckfall(slot);
    };
    match quelle.resolve() {
        Ok(aufgeloest) => Zielsuche::Gefunden(Bindung {
            ziel: InjectTarget::aus(&aufgeloest),
            wacht: aufgeloest.guard(),
        }),
        Err(e) => Zielsuche::NichtAufloesbar(format!("{e:#}")),
    }
}

/// Ohne laufenden Stream: entweder unbekannter Slot (Regelfall) oder — mit
/// gesetztem Labor-Schalter — der primäre Bildschirm als Ersatzrechteck.
fn labor_rueckfall(slot: u32) -> Zielsuche {
    if !crate::env::flag(LABOR_OHNE_STROM) {
        return Zielsuche::KeinStrom;
    }
    match Monitor::primary() {
        Ok(m) => {
            eprintln!(
                "[remote-input] {LABOR_OHNE_STROM}: Slot {slot} ohne Stream → primärer Bildschirm \
                 als Quell-Rechteck (Messweg, kein Produktweg)"
            );
            Zielsuche::Gefunden(Bindung {
                ziel: InjectTarget::Monitor(m.as_raw_hmonitor() as isize),
                wacht: None,
            })
        }
        Err(e) => Zielsuche::NichtAufloesbar(format!("primärer Bildschirm nicht auflösbar: {e}")),
    }
}

/// Stabiler Verweis auf die Aufnahmequelle — nur die Handle-Bits, `Copy`, von
/// jedem Faden nutzbar. Das aufgelöste [`ResolvedTarget`] taugt dafür nicht: es
/// hält bei Fenster-Aufnahme ein nicht-`Send`-Objekt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InjectTarget {
    /// HMONITOR-Bits — Rechteck über `GetMonitorInfoW`.
    Monitor(isize),
    /// HWND-Bits — Rechteck über die DWM-Rahmengrenzen.
    Window(isize),
}

impl InjectTarget {
    fn aus(aufgeloest: &ResolvedTarget) -> Self {
        match aufgeloest {
            ResolvedTarget::Monitor { monitor, .. } => {
                InjectTarget::Monitor(monitor.as_raw_hmonitor() as isize)
            }
            ResolvedTarget::Window(window) => InjectTarget::Window(window.as_raw_hwnd() as isize),
        }
    }

    /// Aktuelles Quell-Rechteck in physischen Bildschirmkoordinaten, oder
    /// `None`, wenn der Handle nicht mehr auflösbar ist (Bildschirm abgesteckt,
    /// Fenster zu). Der Aufrufer verwirft dann die absolute Bewegung.
    pub fn screen_rect(&self) -> Option<RECT> {
        match *self {
            InjectTarget::Monitor(hmon) => {
                let mut info = MONITORINFO {
                    cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                    ..Default::default()
                };
                let ok =
                    unsafe { GetMonitorInfoW(HMONITOR(hmon as *mut std::ffi::c_void), &mut info) };
                ok.as_bool().then_some(info.rcMonitor)
            }
            InjectTarget::Window(hwnd) => fenster_rechteck(HWND(hwnd as *mut std::ffi::c_void)),
        }
    }
}

/// DWM-Rahmengrenzen, **nicht** `GetWindowRect`: WGC nimmt genau die
/// DWM-komponierte Fläche auf; `GetWindowRect` liefert bei modernen Fenstern das
/// um den unsichtbaren Anfassrand größere Rechteck — ein systematischer
/// Klickversatz von rund 7 px. `GetWindowRect` bleibt der Rückfall, falls DWM
/// den Wert verweigert (dann ist ein leicht versetzter Klick besser als keiner).
fn fenster_rechteck(hwnd: HWND) -> Option<RECT> {
    let mut rect = RECT::default();
    let dwm = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut RECT as *mut std::ffi::c_void,
            std::mem::size_of::<RECT>() as u32,
        )
    };
    if dwm.is_ok() {
        return Some(rect);
    }
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect) }.ok().map(|_| rect)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Der erklärte Platz gilt strikt, der ungenannte trägt jeden — die beiden
    /// Regeln aus der Modul-Doku, hier festgehalten.
    #[test]
    fn slot_regeln() {
        assert!(traegt_slot(None, 0));
        assert!(traegt_slot(None, 7));
        assert!(traegt_slot(Some(1), 1));
        assert!(!traegt_slot(Some(1), 0));
    }

    /// Ohne Stream und ohne Labor-Schalter ist der Slot unbekannt — und das
    /// **beendet die Sitzung nicht**.
    #[test]
    fn ohne_strom_ist_der_slot_unbekannt() {
        strom_beendet();
        // Der Schalter ist prozessweit; der Test setzt ihn nicht, also gilt aus.
        if crate::env::flag(LABOR_OHNE_STROM) {
            return;
        }
        assert!(matches!(bindung_fuer_slot(0), Zielsuche::KeinStrom));
    }
}
