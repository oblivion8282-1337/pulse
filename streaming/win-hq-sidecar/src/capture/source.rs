//! `CaptureSource` — was capturen wir.
//!
//! Resolution: `CaptureSource` → konkrete `Monitor`/`Window` aus
//! `windows-capture` via Enum-Match. Source-Picker-UI ist Pulse's Sache, nicht
//! diese Crate.

use anyhow::{Context, Result, anyhow};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONEAREST, MonitorFromRect,
    MonitorFromWindow,
};
use windows::Win32::UI::WindowsAndMessaging::{GetWindowPlacement, IsIconic, WINDOWPLACEMENT};
use windows_capture::monitor::Monitor;
use windows_capture::window::Window;

/// Was gecaptured werden soll. Wire-kompatibel mit der GSR-Linux-Form
/// (`"portal"`/`"window"`/`"monitor"` als String) — Übersetzung in den
/// JSON-Layer (`start`/`build_argv`).
#[derive(Debug, Clone)]
pub enum CaptureSource {
    /// Primärer Monitor (= Windows-Default-Display).
    PrimaryMonitor,
    /// Monitor per 1-basiertem Index (Index 1 = primary, falls von Windows so
    /// sortiert — sonst irgendein verbundener Bildschirm).
    MonitorByIndex(usize),
    /// Erstes Fenster dessen Title das Substring matcht (case-sensitiv).
    WindowByTitle(String),
    /// Fenster per HWND (als Zahl aus dem `list_windows`-Picker). Eindeutiger
    /// als der Titel-Match, wenn mehrere Fenster denselben Titel teilen.
    WindowByHwnd(i64),
}

/// Aufgelöstes Capture-Target — entweder Monitor oder Window.
///
/// Beide implementieren `windows_capture::settings::Settings::new`-input, aber
/// die konkreten Typen sind unterschiedlich. `Settings::new` ist generic über
/// das Item; wir branchen am Call-Site.
#[derive(Debug)]
pub enum ResolvedTarget {
    Monitor {
        monitor: Monitor,
        /// Gesetzt, wenn der User eigentlich ein FENSTER gewählt hat und wir
        /// nur wegen FSE auf Monitor-Capture ausweichen: die Pipelines
        /// schwärzen dann jeden Frame, solange das Fenster nicht auf dem
        /// Schirm ist — sonst streamte der Monitor-Fallback beim Raustabben
        /// den Desktop, obwohl der User NUR das Spiel teilen wollte.
        guard: Option<SourceGuard>,
    },
    Window(Window),
}

impl ResolvedTarget {
    /// Privacy-Guard des Targets (nur beim Fenster→Monitor-Fallback gesetzt).
    pub fn guard(&self) -> Option<SourceGuard> {
        match self {
            ResolvedTarget::Monitor { guard, .. } => *guard,
            ResolvedTarget::Window(_) => None,
        }
    }

    /// Echtes Fenster-Target? (Beim Monitor-Fallback `false` — dort meldet
    /// `on_closed` das Abstecken eines Displays, nicht ein beendetes Spiel.)
    pub fn is_window(&self) -> bool {
        matches!(self, ResolvedTarget::Window(_))
    }

    /// Der Bildschirm, auf dem dieses Ziel liegt — als `HMONITOR`.
    ///
    /// Gebraucht für die Frage, ob dort HDR läuft (`system::hdr`). Beim
    /// Fenster-Ziel ist es der Schirm, auf dem das Fenster gerade LIEGT, und
    /// das ist die einzig sinnvolle Antwort: die Aufnahme bekommt genau die
    /// Bildpunkte, die dieser Schirm darstellt. Zieht der Nutzer das Fenster
    /// während des Streams auf einen anderen Schirm, bleibt die Farbdeutung
    /// die vom Start — das ist bewusst so, weil ein Farbraumwechsel mitten im
    /// Strom für den Zuschauer schlimmer wäre als eine leicht veraltete
    /// Annahme; ein Wechsel verlangt einen neuen Stream.
    ///
    /// `MONITOR_DEFAULTTONEAREST` statt `..TONULL`: ein Fenster, das gerade
    /// keinen Schirm überschneidet (halb aus dem Bild gezogen, minimiert),
    /// soll den nächstgelegenen liefern statt gar keinen — sonst hinge die
    /// Farbentscheidung an der Fensterposition.
    pub fn hmonitor(&self) -> *mut std::ffi::c_void {
        match self {
            ResolvedTarget::Monitor { monitor, .. } => monitor.as_raw_hmonitor(),
            ResolvedTarget::Window(window) => {
                let hwnd = HWND(window.as_raw_hwnd());
                unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) }.0
            }
        }
    }
}

/// Sichtbarkeits-Zustand der Quelle, pro Frame vom `MaskGate` ausgewertet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MaskVerdict {
    /// Quelle sichtbar → echten Frame zeigen.
    Show,
    /// Quelle minimiert → Schwarzbild statt Desktop.
    Mask,
    /// Quelle geschlossen (Spiel beendet) → Stream sauber beenden
    /// (`SOURCE_CLOSED_MARKER`-Pfad).
    Closed,
}

/// Sichtbarkeits-Wächter fürs ursprünglich gewählte Fenster.
///
/// Kontext: hat der User ein Vollbild-Spiel gewählt, capturen wir den MONITOR
/// (s. `resolve_minimized`/FSE-Fallback). Der Monitor zeigt aber den Desktop,
/// sobald das Spiel minimiert ist — und den darf der Stream nie zeigen. Die
/// Pipelines werten deshalb pro Frame den Zustand aus: minimiert → Schwarzbild,
/// geschlossen → Stream-Ende, sonst → Bildinhalt.
///
/// `IsIconic` ist der richtige Sichtbarkeits-Indikator: ein FSE-Spiel ist
/// entweder im Vordergrund (rendert auf den Monitor) oder minimiert — einen
/// Zwischenzustand gibt es nicht. `!is_valid` (Fenster zerstört) ist der
/// „Spiel wurde beendet"-Fall; `IsIconic` allein lieferte auf totem HWND
/// `false`, der Stream fiele wortlos auf den Desktop zurück.
///
/// Nur Win32-Reads auf einem HWND-Zahlenwert — von jedem Thread aufrufbar.
#[derive(Debug, Clone, Copy)]
pub struct SourceGuard {
    hwnd: isize,
}

impl SourceGuard {
    fn new(hwnd: isize) -> Self {
        Self { hwnd }
    }

    /// Ist die bewachte Quelle gerade sichtbar (nicht minimiert, nicht
    /// geschlossen)? Die Fernsteuerung verwirft jede Eingabe, solange sie es
    /// nicht ist — der Steuernde sieht dann Schwarzbild und darf nicht blind
    /// klicken (`Sitzung::frames` in `pulse_fernsteuerung::sitzung`).
    pub fn is_source_visible(&self) -> bool {
        matches!(self.probe(), MaskVerdict::Show)
    }

    fn probe(&self) -> MaskVerdict {
        let win = Window::from_raw_hwnd(self.hwnd as usize as *mut std::ffi::c_void);
        if !win.is_valid() {
            MaskVerdict::Closed
        } else if unsafe { IsIconic(HWND(win.as_raw_hwnd())) }.as_bool() {
            MaskVerdict::Mask
        } else {
            MaskVerdict::Show
        }
    }
}

/// Pro-Frame-Auswerter des Guards mit Übergangs-Logging (einmal pro Wechsel,
/// nicht pro Frame). Von allen drei Capture-Handlern benutzt.
pub struct MaskGate {
    guard: Option<SourceGuard>,
    was_masked: bool,
    /// `Closed` ist final: Windows recycelt HWND-Werte — ein später wieder
    /// „gültiges" Handle wäre ein FREMDES Fenster, kein wiederauferstandenes
    /// Spiel. Ohne Latch könnte das den Stream demaskieren.
    closed: bool,
}

impl MaskGate {
    pub fn new(guard: Option<SourceGuard>) -> Self {
        Self { guard, was_masked: false, closed: false }
    }

    /// Existiert überhaupt ein Guard? (Ohne Guard liefert `frame_masked()`
    /// immer `false` — die GPU-Pfade sparen sich die schwarze Ersatztextur.)
    pub fn has_guard(&self) -> bool {
        self.guard.is_some()
    }

    /// Pro Frame aufrufen: `false` = echten Frame zeigen, `true` = Schwarzbild
    /// statt Desktop-Inhalt.
    ///
    /// `Err` = Quelle geschlossen (Spiel beendet). Der Fehler trägt
    /// `SOURCE_CLOSED_MARKER`, damit `stream_controller::worker_finished`
    /// daraus einen sauberen Stop macht statt eines Fehler-Events.
    pub fn frame_masked(&mut self) -> Result<bool> {
        match self.check() {
            MaskVerdict::Show => Ok(false),
            MaskVerdict::Mask => Ok(true),
            MaskVerdict::Closed => Err(super::source_closed_err()),
        }
    }

    /// Zustands-Auswertung inkl. Übergangs-Logging.
    fn check(&mut self) -> MaskVerdict {
        let Some(guard) = self.guard else {
            return MaskVerdict::Show;
        };
        if self.closed {
            return MaskVerdict::Closed;
        }
        let verdict = guard.probe();
        match verdict {
            MaskVerdict::Closed => {
                self.closed = true;
                eprintln!("[source] Quell-Fenster geschlossen (Spiel beendet) → Stream wird beendet");
            }
            MaskVerdict::Mask if !self.was_masked => {
                self.was_masked = true;
                eprintln!(
                    "[source] Quell-Fenster minimiert → Stream zeigt Schwarzbild (nie den Desktop)"
                );
            }
            MaskVerdict::Show if self.was_masked => {
                self.was_masked = false;
                eprintln!("[source] Quell-Fenster wieder sichtbar → Stream zeigt Bildinhalt");
            }
            _ => {}
        }
        verdict
    }
}

impl CaptureSource {
    pub fn resolve(&self) -> Result<ResolvedTarget> {
        match self {
            // Explizite Monitor-Wahl: Desktop-Streaming ist gewollt → kein Guard.
            CaptureSource::PrimaryMonitor => Ok(ResolvedTarget::Monitor {
                monitor: Monitor::primary().context("Monitor::primary failed")?,
                guard: None,
            }),
            CaptureSource::MonitorByIndex(idx) => {
                let monitor =
                    Monitor::from_index(*idx).map_err(|e| anyhow!("Monitor::from_index({idx}): {e}"))?;
                Ok(ResolvedTarget::Monitor { monitor, guard: None })
            }
            CaptureSource::WindowByTitle(needle) => {
                // `Window::from_contains_name` matcht eine Substring; perfekt
                // für Pulse-UI wo der User "Brave" oder "VS Code" eingeben kann.
                let win = Window::from_contains_name(needle)
                    .map_err(|e| anyhow!("Window::from_contains_name({needle:?}): {e}"))?;
                resolve_window_or_monitor(win, needle)
            }
            CaptureSource::WindowByHwnd(hwnd) => {
                // HWND-Bits zurück in den Pointer. `is_valid()` fängt ein
                // inzwischen geschlossenes Fenster ab (User wählte, schloss es,
                // startete dann) statt erst tief in der Capture zu crashen.
                let win = Window::from_raw_hwnd(*hwnd as usize as *mut std::ffi::c_void);
                if !win.is_valid() {
                    return Err(anyhow!("Fenster (HWND {hwnd}) existiert nicht mehr"));
                }
                resolve_window_or_monitor(win, &format!("HWND {hwnd}"))
            }
        }
    }
}

/// FSE-Fallback für Fenster-Quellen. Ein Spiel im **exklusiven Vollbild**
/// (Fullscreen Exclusive) hält sein HWND oft als winzigen Sliver weit OFF-SCREEN
/// (z. B. CS2: 158×26 bei (-21333,-21333)) — die echte Bild-Ausgabe läuft auf
/// dem Monitor, nicht über das Fenster. WGC-Fenster-Capture eines solchen
/// Slivers liefert nichts (kein Frame → Stream geht nicht live, Stop hängt).
///
/// Erkennen wir, dass das Fenster seinen Monitor **nicht mehr überschneidet**
/// (komplett off-screen) → capturere transparent den Monitor. Monitor-Capture
/// (Desktop Duplication API) übersteht exklusives Vollbild. Ein normales Fenster
/// — auch randloses Vollbild, das den Monitor voll überschneidet — bleibt auf
/// Fenster-Capture (DWM kompositet es, WGC capturet es fehlerfrei).
///
/// Minimierte Fenster gehen vorher an `resolve_minimized` — deren
/// `GetWindowRect` liegt auf einer Sonderposition und würde die
/// Off-Screen-Erkennung unten unterschiedslos auslösen.
///
/// Bei Abfragefehlern (kein Monitor-/Fenster-Rect) → Fenster-Target (blockt nie).
fn resolve_window_or_monitor(win: Window, label: &str) -> Result<ResolvedTarget> {
    // Minimiert? → eigener Pfad. Er bestimmt Monitor + Abdeckung aus der
    // WIEDERHERGESTELLTEN Position, nicht aus `win.monitor()`/`GetWindowRect` —
    // die zeigen bei einem minimierten Fenster auf die Off-Screen-Sonderposition
    // und liefern (v.a. Multi-Monitor) den falschen Monitor. Deshalb VOR dem
    // `win.monitor()`-Early-Return: dessen `MONITOR_DEFAULTTONULL` kann bei
    // minimiert `None` sein und würde fälschlich in Fenster-Capture zurückfallen.
    if unsafe { IsIconic(HWND(win.as_raw_hwnd())) }.as_bool() {
        return resolve_minimized(win, label);
    }
    let Some(mon) = win.monitor() else {
        return Ok(ResolvedTarget::Window(win));
    };
    let mon_rect = monitor_rect_for(&win);
    let win_rect = win.rect().ok();
    let offscreen = matches!((win_rect, mon_rect), (Some(w), Some(m)) if !rects_overlap(&w, &m));
    if offscreen {
        eprintln!(
            "[source] Fenster ({label}) liegt off-screen (FSE/versteckt) → capturere Monitor \
             statt Fenster (WGC kann das Fenster-Sliver nicht capturen)"
        );
        return Ok(guarded_monitor(mon, &win));
    }
    Ok(ResolvedTarget::Window(win))
}

/// Monitor-Target mit Privacy-Guard aufs ursprünglich gewählte Fenster — der
/// einzige Weg, auf dem ein Fenster-Wunsch als Monitor-Capture endet.
fn guarded_monitor(monitor: Monitor, win: &Window) -> ResolvedTarget {
    let guard = Some(SourceGuard::new(win.as_raw_hwnd() as isize));
    ResolvedTarget::Monitor { monitor, guard }
}

/// Ab welcher Monitor-Abdeckung ein minimiertes Fenster als Vollbild-App gilt.
/// Gemessen (2026-07-22, Axiom Verge im exklusiven Vollbild, minimiert per
/// Alt-Tab): `rcNormalPosition` = 2560x1440 @ (0,0) = exakt 100 %. Die kleine
/// Toleranz fängt DPI-/Rahmen-Rundung ab, ohne dass ein normales Fenster in
/// den Monitor-Pfad rutscht.
const FULLSCREEN_COVERAGE_PCT: f64 = 98.0;

/// Minimiertes Fenster: Monitor-Capture oder Fehler?
///
/// Ein Spiel im **exklusiven Vollbild** minimiert sich zwangsläufig, sobald es
/// den Fokus verliert — und um in Pulse auf „Stream starten" zu klicken, muss
/// der User Pulse fokussieren. Ein harter „bitte wiederherstellen"-Fehler wäre
/// hier also prinzipiell unerfüllbar und sperrte den Hauptanwendungsfall von
/// HQ-Streaming aus. Für ein normales minimiertes Fenster ist derselbe Fehler
/// dagegen richtig: dort wäre der Monitor-Fallback ein Privacy-Unfall (User
/// wollte EIN Fenster streamen, bekäme den ganzen Desktop).
///
/// `GetWindowRect`/`MonitorFromWindow` können die Fälle nicht trennen — ein
/// minimiertes Fenster meldet die Off-Screen-Sonderposition ≈(-32000,-32000)
/// mit Stummel-Größe, und `MonitorFromWindow` liefert dort den falschen Monitor
/// (Multi-Monitor: die Abdeckung fiele fälschlich unter die Schwelle und ein
/// echtes Vollbild-Spiel bekäme den „bitte wiederherstellen"-Fehler).
///
/// Deshalb wird ALLES aus `GetWindowPlacement::rcNormalPosition` abgeleitet —
/// dem Rechteck im *wiederhergestellten* Zustand, das während der Minimierung
/// gültig bleibt und in echten Bildschirmkoordinaten liegt: der Monitor per
/// `MonitorFromRect` (nicht `…FromWindow`), die Abdeckung gegen genau diesen
/// Monitor, und — greift der Fallback — auch das Capture-Target ist genau
/// dieser Monitor (nicht `win.monitor()`).
///
/// Bei unbekanntem Rechteck (Abfragefehler) → Fehler, nicht Monitor-Capture:
/// im Zweifel lieber nicht mehr streamen als der User erwartet.
fn resolve_minimized(win: Window, label: &str) -> Result<ResolvedTarget> {
    // Alles aus der WIEDERHERGESTELLTEN Position: Monitor per `MonitorFromRect`
    // auf `rcNormalPosition` (nicht `…FromWindow` auf der Off-Screen-Minimiert-
    // Position), Abdeckung gegen genau diesen Monitor. Trifft es zu, ist dieser
    // Monitor auch das Capture-Target — nicht der potenziell falsche aus
    // `win.monitor()`.
    let fullscreen_monitor = placement_normal_rect(HWND(win.as_raw_hwnd())).and_then(|r| {
        let hmon = unsafe { MonitorFromRect(&r, MONITOR_DEFAULTTONEAREST) };
        let mon_rect = monitor_rect_by_handle(hmon)?;
        (coverage_pct(&r, &mon_rect) >= FULLSCREEN_COVERAGE_PCT)
            .then(|| Monitor::from_raw_hmonitor(hmon.0))
    });
    if let Some(monitor) = fullscreen_monitor {
        eprintln!(
            "[source] Fenster ({label}) ist minimiert, füllt wiederhergestellt aber den Monitor \
             (Vollbild-App nach Fokus-Verlust) → capturere diesen Monitor statt Fenster"
        );
        return Ok(guarded_monitor(monitor, &win));
    }
    Err(anyhow!(
        "Das gewählte Fenster ist minimiert — bitte wiederherstellen und erneut starten"
    ))
}

/// `rcNormalPosition` — Fenster-Rechteck im wiederhergestellten Zustand.
fn placement_normal_rect(hwnd: HWND) -> Option<RECT> {
    let mut wp = WINDOWPLACEMENT {
        length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
        ..Default::default()
    };
    unsafe { GetWindowPlacement(hwnd, &mut wp) }.ok()?;
    Some(wp.rcNormalPosition)
}

/// Anteil der Monitorfläche, den `win` abdeckt (0–100).
fn coverage_pct(win: &RECT, mon: &RECT) -> f64 {
    let iw = (win.right.min(mon.right) - win.left.max(mon.left)).max(0) as f64;
    let ih = (win.bottom.min(mon.bottom) - win.top.max(mon.top)).max(0) as f64;
    let mon_area = ((mon.right - mon.left) as f64) * ((mon.bottom - mon.top) as f64);
    if mon_area <= 0.0 { 0.0 } else { iw * ih / mon_area * 100.0 }
}

/// Monitor-Rechteck (Screen-Koordinaten) eines HMONITOR via `GetMonitorInfoW`.
fn monitor_rect_by_handle(hmon: HMONITOR) -> Option<RECT> {
    let mut info =
        MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    unsafe { GetMonitorInfoW(hmon, &mut info) }
        .as_bool()
        .then_some(info.rcMonitor)
}

/// Monitor-Rechteck des Bildschirms unter einem (nicht-minimierten) Fenster.
/// `MONITOR_DEFAULTTONEAREST` liefert immer den nächstgelegenen Monitor, auch
/// für ein off-screen-Fenster (FSE-Sliver-Erkennung). NICHT für minimierte
/// Fenster benutzen — dort ist die Fensterposition die Off-Screen-Sonderstelle
/// (s. `resolve_minimized`, das über `rcNormalPosition` geht).
fn monitor_rect_for(win: &Window) -> Option<RECT> {
    let hmon = unsafe { MonitorFromWindow(HWND(win.as_raw_hwnd()), MONITOR_DEFAULTTONEAREST) };
    monitor_rect_by_handle(hmon)
}

/// Achsenparallele Überschneidung zweier Rechtecke (Fläche > 0).
fn rects_overlap(a: &RECT, b: &RECT) -> bool {
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

#[cfg(test)]
mod tests {
    use super::{coverage_pct, rects_overlap, FULLSCREEN_COVERAGE_PCT};
    use windows::Win32::Foundation::RECT;

    fn rect(l: i32, t: i32, r: i32, b: i32) -> RECT {
        RECT { left: l, top: t, right: r, bottom: b }
    }

    // Ein 2560x1440-Monitor bei (0,0) und ein zweiter rechts daneben bei (2560,0).
    fn mon1() -> RECT {
        rect(0, 0, 2560, 1440)
    }
    fn mon2() -> RECT {
        rect(2560, 0, 5120, 1440)
    }

    #[test]
    fn fullscreen_game_covers_its_monitor() {
        // rcNormalPosition eines Vollbild-Spiels = voller Monitor → 100 %,
        // klar über der Schwelle → Monitor-Fallback greift.
        assert_eq!(coverage_pct(&mon1(), &mon1()), 100.0);
        assert!(coverage_pct(&mon1(), &mon1()) >= FULLSCREEN_COVERAGE_PCT);
    }

    #[test]
    fn game_on_second_monitor_checked_against_its_own_monitor() {
        // Spiel füllt Monitor 2 → gegen Monitor 2 gerechnet 100 % (der Fix:
        // wir bestimmen den Monitor aus rcNormalPosition, nicht aus der
        // Minimiert-Position).
        assert!(coverage_pct(&mon2(), &mon2()) >= FULLSCREEN_COVERAGE_PCT);
    }

    #[test]
    fn wrong_monitor_would_reject_a_real_fullscreen_game() {
        // DER BUG: das Spiel liegt auf Monitor 2, aber gegen Monitor 1 gerechnet
        // (was MonitorFromWindow auf der Off-Screen-Minimiert-Position lieferte)
        // ergibt 0 % → ein echtes Vollbild-Spiel bekäme fälschlich den
        // "bitte wiederherstellen"-Fehler. Genau das verhindert der Fix.
        assert_eq!(coverage_pct(&mon2(), &mon1()), 0.0);
        assert!(coverage_pct(&mon2(), &mon1()) < FULLSCREEN_COVERAGE_PCT);
    }

    #[test]
    fn normal_window_stays_below_threshold() {
        // Ein normales 1350x1226-Fenster deckt den 2560x1440-Monitor nur zu
        // ~45 % ab → kein Monitor-Fallback (Privacy: es bliebe Fenster-Capture
        // bzw. der actionable Fehler).
        let win = rect(200, 100, 1550, 1326);
        let cov = coverage_pct(&win, &mon1());
        assert!(cov < FULLSCREEN_COVERAGE_PCT, "coverage war {cov}");
    }

    #[test]
    fn coverage_clamps_negative_overlap_to_zero() {
        // Rechtecke ohne Überschneidung → 0 %, nie negativ.
        assert_eq!(coverage_pct(&rect(-500, -500, -100, -100), &mon1()), 0.0);
    }

    #[test]
    fn rects_overlap_basics() {
        assert!(rects_overlap(&rect(0, 0, 100, 100), &rect(50, 50, 150, 150)));
        assert!(!rects_overlap(&rect(0, 0, 100, 100), &rect(100, 0, 200, 100))); // kantenbündig
        assert!(!rects_overlap(&rect(0, 0, 100, 100), &rect(200, 200, 300, 300)));
    }
}
