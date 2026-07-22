/**
 * Fernsteuerung — Input-Encoder (Controller-Seite, M3).
 *
 * Erzeugt die binären Input-Frames, die der Host-Sidecar in `remote_input.rs`
 * (`InputFrame::parse`) liest und per `SendInput` abspielt. **Das Byte-Format
 * MUSS mit der Wire-Spec und dem Rust-Parser übereinstimmen**, voll dokumentiert
 * in `docs/plans/2026-07-22-remote-control-input-wire-protokoll.md`.
 *
 * Little-endian, Byte 0 = Opcode, feste Längen:
 *   0x00 Hello        [u8 version]            2 B
 *   0x01 MouseMoveAbs [u16 x][u16 y]          5 B   (0..65535 aufs Videobild)
 *   0x02 MouseMoveRel [i16 dx][i16 dy]        5 B   (Pointer-Lock, Pixel-Delta)
 *   0x03 MouseButton  [u8 btn][u8 down]       3 B
 *   0x04 MouseWheel   [i16 dv][i16 dh]        5 B   (120 = eine Raste)
 *   0x05 Key          [u16 scan][u8 down]     4 B   (Scancode Set 1)
 *
 * Dieses Modul ist rein (nur Byte-Bau + Mappings) — Event-Listener, Pointer-Lock,
 * Letterbox-Mathematik und Flutkontrolle leben in `capture.ts`, der diese
 * Encoder benutzt.
 */

export const PROTOCOL_VERSION = 1;

/** Wire-Button-Codes (NICHT die JS-`MouseEvent.button`-Nummern — s. `mapButton`). */
export const WireButton = {
  Left: 0,
  Right: 1,
  Middle: 2,
  X1: 3,
  X2: 4,
} as const;
export type WireButton = (typeof WireButton)[keyof typeof WireButton];

const clampU16 = (n: number): number => Math.max(0, Math.min(65535, Math.round(n)));
const clampI16 = (n: number): number => Math.max(-32768, Math.min(32767, Math.round(n)));

/** Legt einen `len`-Byte-Frame mit Opcode in Byte 0 an und liefert Buffer + View (little-endian setzt der Aufrufer). */
function frame(len: number, opcode: number): [Uint8Array<ArrayBuffer>, DataView] {
  const buf = new Uint8Array(len);
  const dv = new DataView(buf.buffer);
  buf[0] = opcode;
  return [buf, dv];
}

/** `0x00` Hello — MUSS die erste Nachricht auf dem DataChannel sein. */
export function helloFrame(version = PROTOCOL_VERSION): Uint8Array<ArrayBuffer> {
  return new Uint8Array([0x00, version & 0xff]);
}

/** `0x01` MouseMoveAbs — x/y auf 0..65535 normiert (Aufrufer rechnet Letterbox raus). */
export function mouseMoveAbs(x: number, y: number): Uint8Array<ArrayBuffer> {
  const [buf, dv] = frame(5, 0x01);
  dv.setUint16(1, clampU16(x), true);
  dv.setUint16(3, clampU16(y), true);
  return buf;
}

/** `0x02` MouseMoveRel — relatives Pixel-Delta (Pointer-Lock). */
export function mouseMoveRel(dx: number, dy: number): Uint8Array<ArrayBuffer> {
  const [buf, dv] = frame(5, 0x02);
  dv.setInt16(1, clampI16(dx), true);
  dv.setInt16(3, clampI16(dy), true);
  return buf;
}

/** `0x03` MouseButton — `btn` = Wire-Code (s. `mapButton`), `down` = gedrückt. */
export function mouseButton(btn: WireButton, down: boolean): Uint8Array<ArrayBuffer> {
  return new Uint8Array([0x03, btn & 0xff, down ? 1 : 0]);
}

/** `0x04` MouseWheel — Wheel-Einheiten (120 = eine Raste), Windows-Vorzeichen. */
export function mouseWheel(deltaV: number, deltaH: number): Uint8Array<ArrayBuffer> {
  const [buf, dv] = frame(5, 0x04);
  dv.setInt16(1, clampI16(deltaV), true);
  dv.setInt16(3, clampI16(deltaH), true);
  return buf;
}

/** `0x05` Key — voller Scancode Set 1 (Extended als `0xE0xx`), `down` = gedrückt. */
export function keyFrame(scan: number, down: boolean): Uint8Array<ArrayBuffer> {
  const [buf, dv] = frame(4, 0x05);
  dv.setUint16(1, scan & 0xffff, true);
  buf[3] = down ? 1 : 0;
  return buf;
}

/**
 * JS `MouseEvent.button` → Wire-Button. Die Nummerierungen unterscheiden sich:
 * JS ist 0=links 1=**mitte** 2=**rechts** 3=zurück(X1) 4=vor(X2), die Wire-Form
 * 0=links 1=rechts 2=mitte 3=X1 4=X2 (passt zu `remote_input::button_event`).
 * `undefined` = unbekannter Button → Aufrufer verwirft das Event.
 */
export function mapButton(jsButton: number): WireButton | undefined {
  switch (jsButton) {
    case 0:
      return WireButton.Left;
    case 1:
      return WireButton.Middle;
    case 2:
      return WireButton.Right;
    case 3:
      return WireButton.X1;
    case 4:
      return WireButton.X2;
    default:
      return undefined;
  }
}

/**
 * JS-Wheel-Delta → Windows-Wheel-Einheiten (120 = eine Raste), Vorzeichen
 * gedreht: JS `deltaY > 0` = zum Nutzer hin (nach unten), Windows `dv > 0` =
 * vom Nutzer weg (nach oben). Pixel-Modus (`deltaMode 0`) wird best-effort auf
 * 120er-Schritte gebracht (~100 px ≈ eine Raste, Chromium); Zeilen-/Seiten-Modus
 * (1/2) gilt bereits als ganze Raste(n).
 */
export function wheelToUnits(delta: number, deltaMode: number): number {
  if (delta === 0) return 0;
  if (deltaMode === 0) {
    // Pixel → Rasten (mind. eine, Richtung erhalten), dann gedreht.
    const notches = Math.max(1, Math.round(Math.abs(delta) / 100)) * Math.sign(delta);
    return -notches * 120;
  }
  // Zeilen (1) / Seiten (2): jede Einheit ist eine Raste.
  return -Math.round(delta) * 120;
}

/**
 * `KeyboardEvent.code` → Windows Scancode Set 1. Extended-Keys tragen den
 * `0xE0`-Prefix im hohen Byte (der Host setzt daraus das EXTENDEDKEY-Flag).
 * `undefined` = nicht abgebildet → Taste wird nicht gesendet.
 *
 * `Pause` fehlt bewusst (`0xE1`-Prefix-Sonderfall, v1 ausgespart, s. Wire-Spec).
 * Layoutunabhängig: der `code` ist die physische Taste, keine Locale nötig.
 */
export function scancodeFor(code: string): number | undefined {
  return SCANCODE_SET1[code];
}

/* eslint-disable prettier/prettier */
const SCANCODE_SET1: Record<string, number> = {
  // Buchstabenreihe (physische Positionen, layoutunabhängig)
  KeyA: 0x1e, KeyB: 0x30, KeyC: 0x2e, KeyD: 0x20, KeyE: 0x12, KeyF: 0x21,
  KeyG: 0x22, KeyH: 0x23, KeyI: 0x17, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26,
  KeyM: 0x32, KeyN: 0x31, KeyO: 0x18, KeyP: 0x19, KeyQ: 0x10, KeyR: 0x13,
  KeyS: 0x1f, KeyT: 0x14, KeyU: 0x16, KeyV: 0x2f, KeyW: 0x11, KeyX: 0x2d,
  KeyY: 0x15, KeyZ: 0x2c,
  // Zifferreihe
  Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06,
  Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b,
  // Symbole der Hauptreihe
  Minus: 0x0c, Equal: 0x0d, Backquote: 0x29, BracketLeft: 0x1a,
  BracketRight: 0x1b, Backslash: 0x2b, Semicolon: 0x27, Quote: 0x28,
  Comma: 0x33, Period: 0x34, Slash: 0x35, IntlBackslash: 0x56,
  // Steuertasten
  Escape: 0x01, Backspace: 0x0e, Tab: 0x0f, Enter: 0x1c, Space: 0x39,
  CapsLock: 0x3a,
  ShiftLeft: 0x2a, ShiftRight: 0x36, ControlLeft: 0x1d, AltLeft: 0x38,
  // Rechte Modifier + Windows-Tasten sind extended (0xE0xx)
  ControlRight: 0xe01d, AltRight: 0xe038, MetaLeft: 0xe05b, MetaRight: 0xe05c,
  ContextMenu: 0xe05d,
  // Funktionstasten
  F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41,
  F8: 0x42, F9: 0x43, F10: 0x44, F11: 0x57, F12: 0x58,
  // Navigationsblock (alle extended)
  Insert: 0xe052, Delete: 0xe053, Home: 0xe047, End: 0xe04f,
  PageUp: 0xe049, PageDown: 0xe051,
  ArrowUp: 0xe048, ArrowDown: 0xe050, ArrowLeft: 0xe04b, ArrowRight: 0xe04d,
  // Ziffernblock
  NumLock: 0x45, NumpadDivide: 0xe035, NumpadMultiply: 0x37,
  NumpadSubtract: 0x4a, NumpadAdd: 0x4e, NumpadEnter: 0xe01c,
  NumpadDecimal: 0x53,
  Numpad0: 0x52, Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad4: 0x4b,
  Numpad5: 0x4c, Numpad6: 0x4d, Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49,
  // Sonstige
  ScrollLock: 0x46, PrintScreen: 0xe037,
};
/* eslint-enable prettier/prettier */
