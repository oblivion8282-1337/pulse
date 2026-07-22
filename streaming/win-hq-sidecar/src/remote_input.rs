//! Fernsteuerung — Input-Parser + `SendInput`-Injektor (M2c).
//!
//! Der Controller schickt über den WebRTC-DataChannel binäre Input-Frames (voll
//! spezifiziert in `docs/plans/2026-07-22-remote-control-input-wire-protokoll.md`).
//! Dieses Modul parst sie (`InputFrame::parse`, rein + unit-getestet) und spielt
//! sie per `SendInput` auf dem Host ab (`InputInjector`).
//!
//! Zwei Härtungs-Zusagen aus der Spec, hier umgesetzt:
//! - **Release-all beim Ende:** jeder gedrückte Button / jede gedrückte Taste
//!   wird bei Session-Ende (regulär, Disconnect, oder Protokollfehler) mit einem
//!   Up-Event freigegeben — sonst liefe nach einem Disconnect die W-Taste im
//!   Spiel für immer weiter.
//! - **Fail-closed:** unbekannter Opcode, falsche Frame-Länge, fehlendes/falsches
//!   Hello oder ein unbekannter Button „vergiftet" den Injektor: alles Gedrückte
//!   wird freigegeben, weiterer Input ignoriert und ein `remote_state`-Event
//!   gesendet. Missgeformter Input über einen per Consent bestätigten,
//!   DTLS-gesicherten Kanal ist ein Bug oder ein Angriff — beenden schlägt raten.

use std::collections::HashSet;
use std::sync::Mutex;

use windows::Win32::Foundation::RECT;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_MOUSE, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, MOUSEEVENTF_ABSOLUTE,
    MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN,
    MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
    MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, MOUSEINPUT,
    MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    XBUTTON1, XBUTTON2,
};

use crate::capture::{InjectTarget, SourceGuard};

/// Protokoll-Version im Hello-Frame. Alles andere → fail-closed.
const PROTOCOL_VERSION: u8 = 1;

/// Prozess auf Per-Monitor-DPI-Awareness v2 setzen. Muss vor jeder Koordinaten-/
/// Monitor-Abfrage laufen (in `main`), sonst liefert Windows bei Skalierung ≠
/// 100 % virtualisierte Werte → Injektion + Capture-Rechtecke wären versetzt.
pub fn set_dpi_awareness() -> Result<(), String> {
    use windows::Win32::UI::HiDpi::{
        SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) }
        .map_err(|e| e.to_string())
}

// ── Frame-Parsing (rein, plattformunabhängig, unit-getestet) ────────────────

/// Ein dekodierter Input-Frame vom Controller. Koordinaten/Deltas sind noch roh
/// (0..65535 normiert bzw. Pixel/Wheel-Einheiten) — die Umrechnung aufs
/// Quell-Rechteck macht der Injektor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputFrame {
    /// `0x00` — Handschlag, MUSS die erste Nachricht sein.
    Hello { version: u8 },
    /// `0x01` — absolute Maus, x/y ∈ 0..65535 normiert aufs Videobild.
    MouseMoveAbs { x: u16, y: u16 },
    /// `0x02` — relative Maus (Pointer-Lock), Pixel-Delta.
    MouseMoveRel { dx: i16, dy: i16 },
    /// `0x03` — Maustaste. `btn`: 0=links 1=rechts 2=mitte 3=X1 4=X2.
    MouseButton { btn: u8, down: bool },
    /// `0x04` — Mausrad, Wheel-Einheiten (120 = eine Raste). `dv` vertikal,
    /// `dh` horizontal, Windows-Vorzeichen (dv>0 = vom Nutzer weg).
    MouseWheel { dv: i16, dh: i16 },
    /// `0x05` — Taste per Windows Scancode Set 1, Extended als `0xE0xx`.
    Key { scan: u16, down: bool },
}

/// Warum ein Frame nicht dekodierbar war — beides führt zu fail-closed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    /// Leerer Frame oder unbekanntes Opcode-Byte.
    UnknownOpcode(Option<u8>),
    /// Bekanntes Opcode, aber falsche Byte-Länge.
    BadLength { opcode: u8, expected: usize, got: usize },
}

impl InputFrame {
    /// Little-endian, Byte 0 = Opcode, feste Längen. Fehler → der Aufrufer
    /// beendet die Session (fail-closed).
    pub fn parse(data: &[u8]) -> Result<InputFrame, ParseError> {
        let opcode = *data.first().ok_or(ParseError::UnknownOpcode(None))?;
        // Exakte Länge pro Opcode; `le_u16`/`le_i16` lesen ab Offset 1.
        let check = |expected: usize| -> Result<(), ParseError> {
            if data.len() == expected {
                Ok(())
            } else {
                Err(ParseError::BadLength { opcode, expected, got: data.len() })
            }
        };
        let le_u16 = |off: usize| u16::from_le_bytes([data[off], data[off + 1]]);
        let le_i16 = |off: usize| i16::from_le_bytes([data[off], data[off + 1]]);
        match opcode {
            0x00 => {
                check(2)?;
                Ok(InputFrame::Hello { version: data[1] })
            }
            0x01 => {
                check(5)?;
                Ok(InputFrame::MouseMoveAbs { x: le_u16(1), y: le_u16(3) })
            }
            0x02 => {
                check(5)?;
                Ok(InputFrame::MouseMoveRel { dx: le_i16(1), dy: le_i16(3) })
            }
            0x03 => {
                check(3)?;
                Ok(InputFrame::MouseButton { btn: data[1], down: data[2] != 0 })
            }
            0x04 => {
                check(5)?;
                Ok(InputFrame::MouseWheel { dv: le_i16(1), dh: le_i16(3) })
            }
            0x05 => {
                check(4)?;
                Ok(InputFrame::Key { scan: le_u16(1), down: data[3] != 0 })
            }
            other => Err(ParseError::UnknownOpcode(Some(other))),
        }
    }
}

// ── Koordinaten-Mapping (rein, unit-getestet) ───────────────────────────────

/// Normierte Videobild-Koordinate (0..65535) → physischer Screen-Punkt im
/// Quell-Rechteck. Ins Rechteck geclampt: der Controller kann nur dorthin
/// zeigen, wo er per Capture auch hinsieht (Consent-Kohärenz).
fn normalized_to_screen(x: u16, y: u16, rect: &RECT) -> (i32, i32) {
    let w = (rect.right - rect.left).max(1);
    let h = (rect.bottom - rect.top).max(1);
    // Auf (w-1)/(h-1) skalieren, damit 65535 exakt auf den letzten Pixel fällt.
    let px = rect.left + ((x as i64 * (w - 1) as i64 + 32767) / 65535) as i32;
    let py = rect.top + ((y as i64 * (h - 1) as i64 + 32767) / 65535) as i32;
    (
        px.clamp(rect.left, rect.right - 1),
        py.clamp(rect.top, rect.bottom - 1),
    )
}

/// Grenzen des virtuellen Desktops (alle Monitore), physische Pixel.
struct VirtualDesktop {
    x: i32,
    y: i32,
    cx: i32,
    cy: i32,
}

fn virtual_desktop() -> VirtualDesktop {
    unsafe {
        VirtualDesktop {
            x: GetSystemMetrics(SM_XVIRTUALSCREEN),
            y: GetSystemMetrics(SM_YVIRTUALSCREEN),
            cx: GetSystemMetrics(SM_CXVIRTUALSCREEN),
            cy: GetSystemMetrics(SM_CYVIRTUALSCREEN),
        }
    }
}

/// Physischer Screen-Punkt → `SendInput`-Absolutkoordinate (0..65535 über den
/// GESAMTEN virtuellen Desktop, wie im M0-PoC verifiziert).
fn screen_to_absolute(px: i32, py: i32, vd: &VirtualDesktop) -> (i32, i32) {
    let nx = ((px - vd.x) as i64 * 65535 / (vd.cx - 1).max(1) as i64) as i32;
    let ny = ((py - vd.y) as i64 * 65535 / (vd.cy - 1).max(1) as i64) as i32;
    (nx, ny)
}

// ── Injektor (Win32 `SendInput`) ────────────────────────────────────────────

/// Spielt geparste Frames per `SendInput` ab und hält den Druck-Zustand für das
/// Release-all. Über `Arc` geteilt: eine Referenz lebt im `on_input`-Callback
/// (webrtc-Task), eine im `RemoteController` (für `release_all` bei Stop).
pub struct InputInjector {
    /// Quelle für das Koordinaten-Mapping (absolute Maus). `None` = ohne
    /// auflösbare Quelle → absolute Bewegungen werden verworfen.
    target: Option<InjectTarget>,
    /// Privacy-Guard (nur beim Fenster→Monitor-FSE-Fallback gesetzt): solange die
    /// Quelle maskiert ist, sieht der Controller Schwarzbild → Input verwerfen.
    guard: Option<SourceGuard>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// Hello empfangen? Der erste Frame MUSS `Hello{version:1}` sein.
    handshaked: bool,
    /// Vergiftet nach einem Protokollfehler → weiterer Input wird ignoriert.
    poisoned: bool,
    /// Gedrückte Maustasten (btn-Code) — für Release-all.
    buttons: HashSet<u8>,
    /// Gedrückte Tasten (voller Scancode inkl. `0xE0`-Prefix) — für Release-all.
    keys: HashSet<u16>,
}

impl InputInjector {
    /// Baut den Injektor für die aktuelle Stream-Quelle. Löst die Quelle **einmal**
    /// zum Session-Start auf (ein laufender Stream ist Voraussetzung); das
    /// Rechteck selbst wird pro Frame frisch gelesen (Fenster bewegen sich).
    pub fn for_active_stream() -> Self {
        let resolved = crate::stream_controller::active_capture_source()
            .and_then(|src| src.resolve().ok());
        let target = resolved.as_ref().map(|r| r.inject_target());
        let guard = resolved.as_ref().and_then(|r| r.guard());
        if target.is_none() {
            eprintln!(
                "[remote-input] keine auflösbare Capture-Quelle — absolute Maus wird verworfen \
                 (relative Maus / Klicks / Tasten laufen weiter)"
            );
        }
        Self {
            target,
            guard,
            state: Mutex::new(State::default()),
        }
    }

    /// Ein DataChannel-Frame vom Controller. Parst + injiziert. Bei
    /// Protokollfehler: vergiften, alles freigeben, `remote_state`-Event.
    pub fn handle(&self, data: &[u8]) {
        // Lock nur für den Poison-Check halten und VOR dem Parsen/Poison wieder
        // freigeben (`poison` nimmt ihn selbst — sonst Deadlock).
        if self.state.lock().unwrap().poisoned {
            return;
        }
        let frame = match InputFrame::parse(data) {
            Ok(f) => f,
            Err(e) => {
                self.poison(&format!("ungültiger Input-Frame: {e:?}"));
                return;
            }
        };

        // Handschlag-Gate: der erste Frame MUSS ein gültiges Hello sein.
        match frame {
            InputFrame::Hello { version } => {
                if version != PROTOCOL_VERSION {
                    self.poison(&format!(
                        "Input-Protokoll-Version {version} ≠ {PROTOCOL_VERSION}"
                    ));
                } else {
                    self.state.lock().unwrap().handshaked = true;
                }
                return;
            }
            _ => {
                if !self.state.lock().unwrap().handshaked {
                    self.poison("Input vor dem Hello-Handschlag");
                    return;
                }
            }
        }

        if let Err(reason) = self.inject(frame) {
            self.poison(&reason);
        }
    }

    /// Injiziert einen (bereits validierten, post-Handschlag) Frame.
    fn inject(&self, frame: InputFrame) -> Result<(), String> {
        match frame {
            InputFrame::Hello { .. } => Ok(()), // oben behandelt
            InputFrame::MouseMoveAbs { x, y } => {
                self.inject_move_abs(x, y);
                Ok(())
            }
            InputFrame::MouseMoveRel { dx, dy } => {
                send_mouse(dx as i32, dy as i32, 0, MOUSEEVENTF_MOVE);
                Ok(())
            }
            InputFrame::MouseButton { btn, down } => self.inject_button(btn, down),
            InputFrame::MouseWheel { dv, dh } => {
                if dv != 0 {
                    send_mouse(0, 0, dv as i32, MOUSEEVENTF_WHEEL);
                }
                if dh != 0 {
                    send_mouse(0, 0, dh as i32, MOUSEEVENTF_HWHEEL);
                }
                Ok(())
            }
            InputFrame::Key { scan, down } => {
                self.inject_key(scan, down);
                Ok(())
            }
        }
    }

    /// Absolute Maus: verwerfen, wenn die Quelle maskiert ist (Controller sieht
    /// Schwarzbild) oder das Rechteck nicht auflösbar ist.
    fn inject_move_abs(&self, x: u16, y: u16) {
        if let Some(guard) = &self.guard {
            if !guard.is_source_visible() {
                return; // Quelle nicht sichtbar → nicht blind klicken lassen.
            }
        }
        let Some(target) = &self.target else { return };
        let Some(rect) = target.screen_rect() else { return };
        let (px, py) = normalized_to_screen(x, y, &rect);
        let vd = virtual_desktop();
        let (nx, ny) = screen_to_absolute(px, py, &vd);
        send_mouse(
            nx,
            ny,
            0,
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        );
    }

    fn inject_button(&self, btn: u8, down: bool) -> Result<(), String> {
        let (flag, mouse_data) = button_event(btn, down)
            .ok_or_else(|| format!("unbekannte Maustaste: {btn}"))?;
        send_mouse(0, 0, mouse_data, flag);
        track_pressed(&mut self.state.lock().unwrap().buttons, btn, down);
        Ok(())
    }

    fn inject_key(&self, scan: u16, down: bool) {
        send_key(scan, down);
        track_pressed(&mut self.state.lock().unwrap().keys, scan, down);
    }

    /// Injektor stilllegen (Session-Ende / Verbindungsverlust): weiteren Input
    /// **ignorieren** und dann alles Gedrückte freigeben. Wie `poison`, aber OHNE
    /// das `input_error`-Event — ein normales Ende ist kein Protokollfehler.
    /// Das Poison-Flag wird ZUERST gesetzt, damit eine noch im SCTP-Puffer
    /// wartende Key-Down-Nachricht nach dem `release_all()` keine Taste
    /// re-injiziert (Re-Press-Race beim Stop).
    pub fn disable(&self) {
        self.state.lock().unwrap().poisoned = true;
        self.release_all();
    }

    /// Alles Gedrückte freigeben. Bei jedem Session-Ende aufrufen — sonst bleibt
    /// nach einem Disconnect eine Taste/Maustaste im Host „hängen".
    pub fn release_all(&self) {
        let (buttons, keys) = {
            let mut state = self.state.lock().unwrap();
            (
                std::mem::take(&mut state.buttons),
                std::mem::take(&mut state.keys),
            )
        };
        for btn in buttons {
            if let Some((flag, mouse_data)) = button_event(btn, false) {
                send_mouse(0, 0, mouse_data, flag);
            }
        }
        for scan in keys {
            send_key(scan, false);
        }
    }

    /// Fail-closed: freigeben, vergiften, Event. Idempotent (das `poisoned`-Flag
    /// verhindert doppelte Events).
    fn poison(&self, reason: &str) {
        {
            let mut state = self.state.lock().unwrap();
            if state.poisoned {
                return;
            }
            state.poisoned = true;
        }
        eprintln!("[remote-input] fail-closed: {reason}");
        self.release_all();
        crate::events::emit(serde_json::json!({
            "ev": "remote_state",
            "state": "input_error",
        }));
    }
}

/// Druck-Zustand fürs Release-all nachführen: `down` fügt die Taste/den Button
/// in die Menge ein, ein Up entfernt sie wieder.
fn track_pressed<T: Eq + std::hash::Hash>(set: &mut HashSet<T>, key: T, down: bool) {
    if down {
        set.insert(key);
    } else {
        set.remove(&key);
    }
}

/// btn-Code → (`SendInput`-Flag, mouseData). `None` = unbekannt → fail-closed.
fn button_event(btn: u8, down: bool) -> Option<(MOUSE_EVENT_FLAGS, i32)> {
    Some(match btn {
        0 => (if down { MOUSEEVENTF_LEFTDOWN } else { MOUSEEVENTF_LEFTUP }, 0),
        1 => (if down { MOUSEEVENTF_RIGHTDOWN } else { MOUSEEVENTF_RIGHTUP }, 0),
        2 => (if down { MOUSEEVENTF_MIDDLEDOWN } else { MOUSEEVENTF_MIDDLEUP }, 0),
        3 => (
            if down { MOUSEEVENTF_XDOWN } else { MOUSEEVENTF_XUP },
            XBUTTON1 as i32,
        ),
        4 => (
            if down { MOUSEEVENTF_XDOWN } else { MOUSEEVENTF_XUP },
            XBUTTON2 as i32,
        ),
        _ => return None,
    })
}

/// Ein `MOUSEINPUT`-Event abfeuern. `data` = mouseData (Wheel-Delta / XButton).
fn send_mouse(dx: i32, dy: i32, data: i32, flags: MOUSE_EVENT_FLAGS) {
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data as u32,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
}

/// Eine Taste per Scancode (Set 1) abfeuern. `0xE0`-Prefix → Extended-Flag,
/// Scancode = niederwertiges Byte (Windows-Konvention: das Prefix steckt im
/// Flag, nicht in `wScan`). `wVk = 0` — reine Scancode-Injektion, layoutfrei.
fn send_key(scan: u16, down: bool) {
    let extended = (scan >> 8) == 0xE0;
    let mut flags: KEYBD_EVENT_FLAGS = KEYEVENTF_SCANCODE;
    if extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if !down {
        flags |= KEYEVENTF_KEYUP;
    }
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: (scan & 0xFF) as u16,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(l: i32, t: i32, r: i32, b: i32) -> RECT {
        RECT { left: l, top: t, right: r, bottom: b }
    }

    #[test]
    fn parse_hello() {
        assert_eq!(
            InputFrame::parse(&[0x00, 1]),
            Ok(InputFrame::Hello { version: 1 })
        );
    }

    #[test]
    fn parse_move_abs_little_endian() {
        // x = 0x0201 = 513, y = 0x0403 = 1027
        assert_eq!(
            InputFrame::parse(&[0x01, 0x01, 0x02, 0x03, 0x04]),
            Ok(InputFrame::MouseMoveAbs { x: 513, y: 1027 })
        );
    }

    #[test]
    fn parse_move_rel_signed() {
        // dx = -1 (0xFFFF), dy = 1
        assert_eq!(
            InputFrame::parse(&[0x02, 0xFF, 0xFF, 0x01, 0x00]),
            Ok(InputFrame::MouseMoveRel { dx: -1, dy: 1 })
        );
    }

    #[test]
    fn parse_button() {
        assert_eq!(
            InputFrame::parse(&[0x03, 1, 1]),
            Ok(InputFrame::MouseButton { btn: 1, down: true })
        );
        assert_eq!(
            InputFrame::parse(&[0x03, 0, 0]),
            Ok(InputFrame::MouseButton { btn: 0, down: false })
        );
    }

    #[test]
    fn parse_wheel_signed() {
        // dv = 120 (eine Raste vorwärts), dh = 0
        assert_eq!(
            InputFrame::parse(&[0x04, 120, 0, 0, 0]),
            Ok(InputFrame::MouseWheel { dv: 120, dh: 0 })
        );
    }

    #[test]
    fn parse_key_extended() {
        // scan = 0xE01D (RCtrl), down
        assert_eq!(
            InputFrame::parse(&[0x05, 0x1D, 0xE0, 1]),
            Ok(InputFrame::Key { scan: 0xE01D, down: true })
        );
    }

    #[test]
    fn parse_rejects_unknown_opcode() {
        assert_eq!(
            InputFrame::parse(&[0x7F, 0, 0]),
            Err(ParseError::UnknownOpcode(Some(0x7F)))
        );
    }

    #[test]
    fn parse_rejects_empty() {
        assert_eq!(InputFrame::parse(&[]), Err(ParseError::UnknownOpcode(None)));
    }

    #[test]
    fn parse_rejects_wrong_length() {
        // MouseMoveAbs braucht 5 Bytes, hier nur 3.
        assert_eq!(
            InputFrame::parse(&[0x01, 0x00, 0x00]),
            Err(ParseError::BadLength { opcode: 0x01, expected: 5, got: 3 })
        );
    }

    #[test]
    fn parse_rejects_trailing_bytes() {
        // Zu lang ist genauso ungültig wie zu kurz (fail-closed).
        assert!(InputFrame::parse(&[0x03, 0, 0, 99]).is_err());
    }

    #[test]
    fn map_corners_hit_rect_edges() {
        let r = rect(100, 200, 1100, 800); // 1000x600 @ (100,200)
        // (0,0) → linke obere Ecke.
        assert_eq!(normalized_to_screen(0, 0, &r), (100, 200));
        // (65535,65535) → rechte untere Ecke (letzter Pixel).
        assert_eq!(normalized_to_screen(65535, 65535, &r), (1099, 799));
    }

    #[test]
    fn map_center_is_centered() {
        let r = rect(0, 0, 1921, 1081); // width 1921 → Mitte bei 960
        let (px, py) = normalized_to_screen(32767, 32767, &r);
        // ~Mitte (Rundung ±1).
        assert!((px - 960).abs() <= 1, "px={px}");
        assert!((py - 540).abs() <= 1, "py={py}");
    }

    #[test]
    fn map_clamps_into_rect() {
        let r = rect(0, 0, 100, 100);
        let (px, py) = normalized_to_screen(65535, 65535, &r);
        assert!(px < 100 && py < 100, "innerhalb: {px},{py}");
    }

    #[test]
    fn abs_maps_over_virtual_desktop_with_negative_origin() {
        // Zweitmonitor links vom Primär: Ursprung negativ.
        let vd = VirtualDesktop { x: -2560, y: 0, cx: 5120, cy: 1440 };
        // Punkt am linken Rand (-2560) → 0; rechter Rand (2559) → 65535.
        assert_eq!(screen_to_absolute(-2560, 0, &vd).0, 0);
        assert_eq!(screen_to_absolute(2559, 0, &vd).0, 65535);
    }

    #[test]
    fn extended_key_detection() {
        // Nur der 0xE0-Prefix ist „extended".
        assert!((0xE01Du16 >> 8) == 0xE0);
        assert!((0x001Du16 >> 8) != 0xE0);
    }
}
