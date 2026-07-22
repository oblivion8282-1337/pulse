//! `CaptureSource` — was capturen wir.
//!
//! Resolution: `CaptureSource` → konkrete `Monitor`/`Window` aus
//! `windows-capture` via Enum-Match. Source-Picker-UI ist Pulse's Sache, nicht
//! diese Crate.

use anyhow::{Context, Result, anyhow};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
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
    let Some(mon) = win.monitor() else {
        return Ok(ResolvedTarget::Window(win));
    };
    let mon_rect = monitor_rect_for(&win);
    if unsafe { IsIconic(HWND(win.as_raw_hwnd())) }.as_bool() {
        return resolve_minimized(win, mon, mon_rect, label);
    }
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
/// `GetWindowRect` kann die Fälle nicht trennen — minimierte Fenster melden
/// beide die Sonderposition ≈(-32000,-32000) mit Stummel-Größe.
/// `GetWindowPlacement::rcNormalPosition` liefert dagegen das Rechteck im
/// *wiederhergestellten* Zustand und bleibt während der Minimierung gültig:
/// Vollbild-Spiel → voller Monitor, normales Fenster → sein kleines Rechteck.
///
/// Bei unbekanntem Rechteck (Abfragefehler) → Fehler, nicht Monitor-Capture:
/// im Zweifel lieber nicht mehr streamen als der User erwartet.
fn resolve_minimized(
    win: Window,
    mon: Monitor,
    mon_rect: Option<RECT>,
    label: &str,
) -> Result<ResolvedTarget> {
    let restored = placement_normal_rect(HWND(win.as_raw_hwnd()));
    let covers_monitor = matches!(
        (restored, mon_rect),
        (Some(r), Some(m)) if coverage_pct(&r, &m) >= FULLSCREEN_COVERAGE_PCT
    );
    if covers_monitor {
        eprintln!(
            "[source] Fenster ({label}) ist minimiert, füllt wiederhergestellt aber den Monitor \
             (Vollbild-App nach Fokus-Verlust) → capturere Monitor statt Fenster"
        );
        return Ok(guarded_monitor(mon, &win));
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

/// Monitor-Rechteck in Screen-Koordinaten (Position + Größe) via Win32.
/// `windows_capture::Monitor` liefert nur Breite/Höhe, keine Position — für den
/// Überschneidungs-Check brauchen wir die. `MONITOR_DEFAULTTONEAREST` liefert
/// immer den nächstgelegenen Monitor, auch für ein off-screen-Fenster.
fn monitor_rect_for(win: &Window) -> Option<RECT> {
    let mut info =
        MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    let hmon = unsafe { MonitorFromWindow(HWND(win.as_raw_hwnd()), MONITOR_DEFAULTTONEAREST) };
    if unsafe { GetMonitorInfoW(hmon, &mut info) }.as_bool() {
        Some(info.rcMonitor)
    } else {
        None
    }
}

/// Achsenparallele Überschneidung zweier Rechtecke (Fläche > 0).
fn rects_overlap(a: &RECT, b: &RECT) -> bool {
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}
