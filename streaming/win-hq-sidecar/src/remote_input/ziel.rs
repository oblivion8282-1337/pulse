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
//! Dasselbe gilt für einen Platz **außerhalb** der Schranke ([`SLOT_MAX`]).
//!
//! ## Das Ziel kommt von der Aufnahme, nicht aus einer zweiten Auflösung
//!
//! Welches Fenster bzw. welchen Bildschirm die Fernsteuerung meint, sagt die
//! **Aufnahme** selbst: sie meldet ihr aufgelöstes Ziel über [`ziel_gebunden`],
//! sobald sie es bestimmt hat. Die frühere Fassung rief hier stattdessen ein
//! zweites Mal `CaptureSource::resolve()` auf — und die beiden Antworten laufen
//! auseinander:
//!
//! * Wechselt das aufgenommene Fenster ins exklusive Vollbild, liefert eine
//!   neue Auflösung den ganzen **Monitor**. Die Koordinaten würden dann über den
//!   Monitor gespreizt, während der Zuschauer nur das Fenster sieht — die
//!   Klemm-Zusage der Spezifikation („nur dorthin klicken, wo er per Aufnahme
//!   auch hinsehen darf") wäre gebrochen.
//! * `WindowByTitle` matcht auf eine Teilzeichenkette; zur Injektionszeit kann
//!   das ein **anderes** Fenster treffen als das aufgenommene.
//!
//! ## Das Rechteck
//!
//! Es wird **zur Injektionszeit** gelesen, nicht beim Sitzungsstart: Fenster
//! bewegen sich. Gehalten wird nur der Handle (`InjectTarget`) — der der
//! Aufnahme —, aus dem sich das Rechteck jedes Mal frisch ergibt.

use std::sync::Mutex;

use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, HMONITOR, MONITORINFO};
use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
use windows_capture::monitor::Monitor;

use crate::capture::source::{ResolvedTarget, SourceGuard};

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

/// Labor-Schalter: WELCHER Bildschirm als Quell-Rechteck dient, wenn
/// [`LABOR_OHNE_STROM`] an ist. 1-basiert wie in `ops::list_monitors` und wie
/// `Monitor::from_index` es erwartet; ohne die Variable bleibt es der primäre.
///
/// **Wozu.** Ohne das lässt sich nur der primäre Bildschirm prüfen — und genau
/// die Fälle, an denen Fremdstacks scheitern, liegen auf dem ZWEITEN: die
/// Verschiebung des Quell-Rechtecks gegen den Ursprung des virtuellen Desktops
/// und die Zuordnung eines Punktes auf einen nicht-primären Bildschirm. Am
/// 2026-08-12 wurde ein zweiter Monitor angeschlossen (1920x1200 rechts neben
/// 2560x1440); ohne diesen Schalter wäre er unerreichbar geblieben.
const LABOR_MONITOR: &str = "PULSE_LABOR_EINGABE_MONITOR";

/// Höchster Platz, den dieser Sidecar überhaupt für möglich hält (0..=98).
///
/// Dieselbe Schranke wie `desktop/electron/sidecar.ts::MAX_STREAM_SLOTS` (99
/// Plätze) und `_SLOT_MAX` im chat-gateway — wird sie dort bewegt, gehört sie
/// hier mitgezogen.
///
/// **Wozu die Schranke hier nochmal.** Ohne sie trüge die Regel „ein Stream
/// ohne erklärten Platz trägt jeden Platz" auch ein `slot: 999` — eine Zahl,
/// die es im ganzen System nicht geben kann, landete auf dem einen Stream
/// dieses Prozesses. Ein Platz jenseits der Schranke gilt deshalb als
/// **unbekannt**: still verworfen, Sitzung bleibt stehen. Ausdrücklich **kein**
/// Protokollfehler — sonst genügte ein `slot: 999`, um eine laufende
/// Fernsteuerung abzuwürgen (Spezifikation, „Der `slot`").
pub const SLOT_MAX: u64 = 98;

/// Der laufende Stream dieses Prozesses, für die Fernsteuerung sichtbar.
/// Gesetzt beim `start`, geleert wenn der Worker endet.
static AKTIVER_STROM: Mutex<Option<AktiverStrom>> = Mutex::new(None);

/// Die Registrierung nehmen — **auch eine vergiftete Sperre**. Aus demselben
/// Grund wie bei der Sperre der Fernsteuer-Sitzung
/// (`pulse_fernsteuerung::sitzung::Sitzung`): eine Panik unter der
/// Sperre darf nicht dazu führen, dass danach jeder Zugriff panikt. Hier hinge
/// sonst ausgerechnet [`strom_beendet`] auf dem Abbau-Pfad, und die
/// Fernsteuerung zielte weiter auf einen Stream, den es nicht mehr gibt.
fn registrierung() -> std::sync::MutexGuard<'static, Option<AktiverStrom>> {
    AKTIVER_STROM.lock().unwrap_or_else(|e| e.into_inner())
}

struct AktiverStrom {
    /// Der erklärte Platz — `None` = nicht genannt (s. Modul-Doku).
    slot: Option<u32>,
    /// Das Ziel, das die **Aufnahme** benutzt. `None` = sie hat es noch nicht
    /// bestimmt (zwischen `start` und dem Anlaufen der Aufnahme).
    bindung: Option<Bindung>,
}

/// Trägt ein Stream mit diesem erklärten Platz den angefragten? Die beiden
/// Regeln aus der Modul-Doku: der erklärte Platz gilt strikt, der ungenannte
/// trägt jeden.
fn traegt_slot(erklaert: Option<u32>, angefragt: u64) -> bool {
    erklaert.is_none() || erklaert.map(u64::from) == Some(angefragt)
}

/// Vom [`crate::stream_controller`] beim Start gerufen — der Platz steht da
/// schon fest, das Aufnahmeziel noch nicht (das meldet [`ziel_gebunden`]).
pub fn strom_gestartet(slot: Option<u32>) {
    *registrierung() = Some(AktiverStrom { slot, bindung: None });
}

/// Von der Aufnahme gerufen, sobald sie ihr Ziel aufgelöst hat (`capture/wgc*`).
///
/// **Genau dieses Ziel** bekommt die Fernsteuerung — nicht ein zweites Mal
/// aufgelöstes (Begründung in der Modul-Doku: exklusives Vollbild und
/// `WindowByTitle` lassen zwei Auflösungen auseinanderlaufen, und die Eingabe
/// zielte dann irgendwohin, wo der Zuschauer nichts sieht).
///
/// Ohne angemeldeten Stream folgenlos: die `examples/` und das Labor starten
/// dieselbe Aufnahme, ohne dass eine Fernsteuerung dazugehört.
pub fn ziel_gebunden(aufgeloest: &ResolvedTarget) {
    if let Some(strom) = registrierung().as_mut() {
        strom.bindung = Some(Bindung {
            ziel: InjectTarget::aus(aufgeloest),
            wacht: aufgeloest.guard(),
        });
    }
}

/// Vom [`crate::stream_controller`] gerufen, wenn der Worker endet.
pub fn strom_beendet() {
    *registrierung() = None;
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
/// überhaupt etwas zu sehen ist. Nur Handle-Bits — `Copy`, von jedem Faden
/// lesbar.
#[derive(Debug, Clone, Copy)]
pub struct Bindung {
    pub ziel: InjectTarget,
    /// Sichtschutz (nur beim Fenster→Bildschirm-Rückfall gesetzt): schwärzt er,
    /// sieht der Steuernde Schwarzbild und darf nicht blind klicken.
    pub wacht: Option<SourceGuard>,
}

/// Slot auflösen. Nimmt **jedes Mal** die aktuelle Lage — der Aufrufer darf das
/// Ergebnis für die Dauer einer Nachricht halten, nicht für die Sitzung.
pub fn bindung_fuer_slot(slot: u64) -> Zielsuche {
    // Jenseits der Schranke gibt es diesen Platz nirgends im System —
    // unbekannt, nicht „vom ungenannten Stream getragen" (s. [`SLOT_MAX`]).
    // Vor dem Labor-Rückfall, damit auch der Messweg keinen Fantasieplatz annimmt.
    if slot > SLOT_MAX {
        return Zielsuche::KeinStrom;
    }
    let eintrag = {
        let reg = registrierung();
        reg.as_ref()
            .filter(|s| traegt_slot(s.slot, slot))
            .map(|s| s.bindung)
    };
    match eintrag {
        None => labor_rueckfall(slot),
        // Stream angemeldet, Aufnahme noch nicht angelaufen. Verwerfen (mit
        // Freigabe) statt selbst aufzulösen: eine eigene Auflösung wäre genau
        // die zweite Meinung, gegen die dieses Modul gebaut ist.
        Some(None) => Zielsuche::NichtAufloesbar(
            "die Aufnahme hat ihr Ziel noch nicht gemeldet (Stream läuft gerade an)".to_string(),
        ),
        Some(Some(bindung)) => Zielsuche::Gefunden(bindung),
    }
}

/// Ohne laufenden Stream: entweder unbekannter Slot (Regelfall) oder — mit
/// gesetztem Labor-Schalter — ein Bildschirm als Ersatzrechteck. Welcher,
/// entscheidet [`LABOR_MONITOR`]; ohne die Variable der primäre.
fn labor_rueckfall(slot: u64) -> Zielsuche {
    if !crate::env::flag(LABOR_OHNE_STROM) {
        return Zielsuche::KeinStrom;
    }
    match labor_bildschirm() {
        Ok((m, woher)) => {
            eprintln!(
                "[remote-input] {LABOR_OHNE_STROM}: Slot {slot} ohne Stream → {woher} \
                 als Quell-Rechteck (Messweg, kein Produktweg)"
            );
            Zielsuche::Gefunden(Bindung {
                ziel: InjectTarget::Monitor(m.as_raw_hmonitor() as isize),
                wacht: None,
            })
        }
        Err(e) => Zielsuche::NichtAufloesbar(e),
    }
}

/// Den Labor-Bildschirm auflösen, samt Klartext für die Meldung.
///
/// Ein unbrauchbarer Wert in [`LABOR_MONITOR`] wird **nicht** stillschweigend
/// auf den primären zurückgedreht: Wer den Schalter setzt, misst gezielt einen
/// bestimmten Bildschirm, und ein stiller Rückfall lieferte Zahlen für den
/// falschen — also ein Ergebnis, das plausibel aussieht und nichts belegt.
fn labor_bildschirm() -> Result<(Monitor, String), String> {
    // `crate::env` kennt nur Schalter (an/aus); hier wird eine Zahl gebraucht.
    match std::env::var(LABOR_MONITOR).ok().filter(|s| !s.trim().is_empty()) {
        Some(roh) => {
            let n: u32 = roh
                .trim()
                .parse()
                .map_err(|_| format!("{LABOR_MONITOR}={roh:?} ist keine Zahl (1-basiert)"))?;
            let m = Monitor::from_index(n as usize)
                .map_err(|e| format!("{LABOR_MONITOR}={n}: Bildschirm nicht auflösbar: {e}"))?;
            Ok((m, format!("Bildschirm {n}")))
        }
        None => {
            let m = Monitor::primary()
                .map_err(|e| format!("primärer Bildschirm nicht auflösbar: {e}"))?;
            Ok((m, "primärer Bildschirm".to_string()))
        }
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
        let _sperre = crate::remote_input::pruefstand();
        // Der Schalter ist prozessweit; der Test setzt ihn nicht, also gilt aus.
        if crate::env::flag(LABOR_OHNE_STROM) {
            return;
        }
        assert!(matches!(bindung_fuer_slot(0), Zielsuche::KeinStrom));
    }

    /// Ein Platz jenseits der Schranke ist **unbekannt**, auch wenn ein Stream
    /// ohne erklärten Platz läuft (der „trägt jeden Platz") und auch mit
    /// Labor-Schalter. Sonst landete ein `slot: 999` auf dem einzigen Stream
    /// dieses Prozesses — oder, über den Labor-Weg, auf einem Bildschirm.
    #[test]
    fn platz_jenseits_der_schranke_ist_unbekannt() {
        let _sperre = crate::remote_input::pruefstand();
        strom_gestartet(None);
        assert!(matches!(bindung_fuer_slot(SLOT_MAX + 1), Zielsuche::KeinStrom));
        // Auch jenseits von u32 — hier wurde früher auf `u32::MAX` gekappt.
        assert!(matches!(bindung_fuer_slot(5_000_000_000), Zielsuche::KeinStrom));
        strom_beendet();
    }

    /// Zwischen `start` und dem Anlaufen der Aufnahme gibt es noch kein Ziel.
    /// Verworfen (mit Freigabe beim Aufrufer) — **nicht** selbst aufgelöst.
    #[test]
    fn strom_ohne_gemeldetes_ziel_ist_nicht_aufloesbar() {
        let _sperre = crate::remote_input::pruefstand();
        strom_gestartet(Some(0));
        assert!(matches!(bindung_fuer_slot(0), Zielsuche::NichtAufloesbar(_)));
        // Der erklärte Platz gilt weiterhin strikt — außer der Labor-Schalter
        // steht, dann tritt für den fremden Platz das Ersatzrechteck ein.
        if !crate::env::flag(LABOR_OHNE_STROM) {
            assert!(matches!(bindung_fuer_slot(1), Zielsuche::KeinStrom));
        }
        strom_beendet();
    }
}
