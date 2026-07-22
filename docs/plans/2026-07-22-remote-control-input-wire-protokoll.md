# Fernsteuerung — Input-Wire-Protokoll v1 (M2c)

Entschieden mit dem User am 2026-07-22 (drei Grundsatzfragen: binär / 1 Kanal /
voller v1-Umfang). Dies ist die verbindliche Spezifikation für beide Seiten:
**Controller** (M3, Browser/Electron, JS) erzeugt die Frames, **Host**
(M2c, `win-hq-sidecar`, Rust) parst und injiziert sie.

## Transport

- **Ein** DataChannel, vom Controller eröffnet (Label `input`), **reliable +
  ordered** (WebRTC-Default — keine `maxRetransmits`/`ordered:false`-Optionen).
  Grund: Die Reihenfolge Move→Klick ist semantisch tragend (ein Klick, der
  seine Positionierungs-Bewegung überholt, landet am falschen Ort), und ein
  verlorenes Key-Up wäre eine klemmende Taste.
- Jede DataChannel-Message enthält **genau einen** Frame (kein Batching v1).
- **Flutkontrolle ist Client-Pflicht** (normativ, nicht optional):
  - Mausbewegungen coalescen: höchstens **eine** MouseMove-Nachricht pro
    Animation-Frame; zwischenzeitliche Positionen verwerfen (absolut) bzw.
    aufsummieren (relativ).
  - `bufferedAmount > 64 KiB`: weitere **Moves droppen** (Buttons/Keys/Wheel
    werden NIE gedroppt).

## Frame-Format

Little-endian, Byte 0 = Opcode, feste Längen. Unbekannter Opcode oder falsche
Länge → der Host **beendet die Session** (fail-closed, s. Sicherheit).

| Opcode | Name | Layout | Länge |
|---|---|---|---|
| `0x00` | Hello | `[0x00][u8 version]` | 2 B |
| `0x01` | MouseMoveAbs | `[0x01][u16 x][u16 y]` | 5 B |
| `0x02` | MouseMoveRel | `[0x02][i16 dx][i16 dy]` | 5 B |
| `0x03` | MouseButton | `[0x03][u8 btn][u8 down]` | 3 B |
| `0x04` | MouseWheel | `[0x04][i16 dv][i16 dh]` | 5 B |
| `0x05` | Key | `[0x05][u16 scan][u8 down]` | 4 B |

### Hello (`0x00`)

MUSS die **erste** Nachricht auf dem Kanal sein, `version = 1`. Alles andere
als erste Nachricht, oder eine unbekannte Version → Session beenden. Der Host
antwortet nicht (der Kanal ist eine Einbahnstraße Controller→Host); künftige
Versionen verhandeln über den Signaling-Pfad, nicht hier.

### MouseMoveAbs (`0x01`)

`x`/`y` ∈ 0..65535, normiert auf das **Videobild** (die Capture-Quelle), nicht
auf den Bildschirm des Controllers und nicht auf den Host-Desktop:

- **Controller:** Letterbox-Ränder des `<video>`-Elements abziehen, Position im
  Bild-Inhalt auf `u,v ∈ [0,1]` bringen, `round(u*65535)` senden. Klicks in den
  Letterbox-Rand werden NICHT gesendet.
- **Host:** aktuelles Quell-Rect `R` bestimmen (s. Koordinaten-Mapping),
  `px = R.left + u*(R.width-1)` (analog y), ins Rect clampen, dann absolute
  Injektion wie im M0-PoC (`MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_VIRTUALDESK`,
  Normierung auf den virtuellen Desktop). Δ 0 px auf 3 Monitoren verifiziert
  (M0, 2026-07-22).

### MouseMoveRel (`0x02`)

`dx`/`dy` in Pixeln (Vorzeichen wie Bildschirm-Koordinaten: +x rechts, +y
runter). Host injiziert `MOUSEEVENTF_MOVE` ohne `ABSOLUTE` — Windows wendet
Ballistik/Precision an, das ist für den Pointer-Lock-Fall (Spiele) erwünscht.
**Kein Protokoll-Schalter für den Modus**: Der Client sendet MoveRel genau
dann, wenn er Pointer-Lock hält, sonst MoveAbs. Der Host behandelt beide
zustandslos.

### MouseButton (`0x03`)

`btn`: 0=links, 1=rechts, 2=mitte, 3=X1, 4=X2. `down`: 1=down, 0=up.
Host: `MOUSEEVENTF_{LEFT,RIGHT,MIDDLE}{DOWN,UP}`; X1/X2 via
`MOUSEEVENTF_X{DOWN,UP}` + `mouseData=XBUTTON1/2`. Unbekannter `btn` →
Session beenden (fail-closed, wie unbekannter Opcode).

### MouseWheel (`0x04`)

`dv` (vertikal) / `dh` (horizontal) in **Windows-Rastschritt-Einheiten**
(`WHEEL_DELTA` = 120 pro Raste). Vorzeichen in Windows-Konvention: `dv > 0` =
vom Nutzer weg (nach oben scrollen). **Achtung Controller:** JS `deltaY > 0`
bedeutet zum Nutzer hin → Vorzeichen drehen; `deltaMode`-Pixel-Werte
best-effort auf 120er-Einheiten bringen (Chromium: ~100 px ≈ 1 Raste).
Host: `MOUSEEVENTF_WHEEL` / `MOUSEEVENTF_HWHEEL` mit `mouseData = dv|dh`.

### Key (`0x05`)

`scan` = **Windows Scancode Set 1**; Extended-Keys als `0xE0xx` (z.B. RCtrl
`0xE01D`, Pfeil-links `0xE04B`). Layoutunabhängig — keine Seite braucht
Locale-Wissen:

- **Controller:** statische Tabelle `KeyboardEvent.code` → Scancode (die
  Chromium-`dom_code`-Zuordnung, ~100 Einträge, wird in M3 vendored).
  `Pause` hat einen `0xE1`-Prefix-Sonderfall → **v1 lässt Pause weg** (kein
  Mapping, Taste wird nicht gesendet).
- **Host:** `KEYEVENTF_SCANCODE` (+`KEYEVENTF_EXTENDEDKEY` bei `0xE0`-Prefix),
  `wVk = 0`. Kein VK-Mapping — Scancodes gehen roh an `SendInput`.

## Koordinaten-Mapping (Host)

Das Quell-Rect `R` wird **zur Injektionszeit** aufgelöst, nicht beim
Session-Start (Fenster bewegen sich):

- **Monitor-Capture:** `rcMonitor` des gecapturten Monitors.
- **Fenster-Capture:** `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` —
  NICHT `GetWindowRect`: WGC captured die DWM-Frame-Bounds; `GetWindowRect`
  liefert bei modernen Fenstern den um den unsichtbaren Resize-Rand größeren
  Rect → systematischer Klick-Versatz von ~7 px.
- **FSE-Fallback** (Fenster gewählt, aber Monitor gecaptured): Rect des
  Monitors. Solange der Privacy-Guard schwärzt (Fenster nicht auf dem Schirm),
  wird **sämtlicher Input verworfen** — der Controller ist blind und darf dann
  auch nicht blind klicken.

**DPI-Pflicht:** Der Sidecar-Prozess setzt aktuell KEINE DPI-Awareness. Vor der
ersten Injektion (Prozess-Start, main.rs) MUSS
`SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` laufen — sonst sind alle
Rect-/Koordinaten-APIs bei Skalierung ≠ 100 % virtualisiert und das Mapping
systematisch falsch (M0-Erkenntnis).

## Sicherheit / Robustheit

- **Fail-closed:** Unbekannter Opcode, falsche Frame-Länge, fehlendes/falsches
  Hello, unbekannter Button → `stop_session()` + `remote_state`-Event. Der
  Input kommt vom einzigen, per Consent bestätigten Peer über DTLS — alles
  Missgeformte ist ein Bug oder ein Angriff; in beiden Fällen ist Beenden
  richtiger als Raten.
- **Release-all beim Ende:** Der Host führt die Menge gedrückter Tasten und
  Buttons mit. Bei Session-Ende — egal ob `remote_end`, Disconnect, Kanal zu
  oder fail-closed — injiziert er für alles Gedrückte das Up-Event. Ohne das
  läuft nach einem Disconnect die W-Taste im Spiel für immer weiter.
- **Clamping:** Absolute Koordinaten werden ins Quell-Rect geclampt — der
  Controller kann nur dorthin klicken, wo er per Capture auch hinsehen darf
  (Consent-Kohärenz bei Fenster-Capture).
- **Grenzen der Injektion (dokumentiert, kein Bug):** `SendInput` erreicht
  keine SAS-Sequenzen (Ctrl+Alt+Entf) und keine Fenster mit höherer Integrität
  (UAC-Prompts, Admin-Fenster bei nicht-Admin-Sidecar). Die Windows-Taste geht
  durch (wie Parsec).

## Umsetzung

- **M2c (Host, `win-hq-sidecar`):** Parser + Injektor als eigenes Modul
  (`src/remote_input.rs`), verdrahtet in den `on_input`-Callback in
  `src/remote.rs` (ersetzt das `eprintln`). Injektionscode = M0-PoC
  (`streaming/win-input-poc/src/main.rs`) als Vorlage; der PoC bleibt als
  Standalone-Diagnose bestehen. Der Callback läuft in webrtc-rs-Tasks →
  Injektor muss `Send+Sync` sein; `SendInput` ist thread-safe, der
  Pressed-State kommt hinter einen Mutex (kalt, nur Key/Button-Events).
- **M3 (Controller, JS):** Encoder-Gegenstück (DataView), Letterbox-Mathematik,
  Pointer-Lock-Umschaltung, `code`→Scancode-Tabelle, Flutkontroll-Regeln oben.
- **Mac-Sidecar später:** gleiche Wire-Frames; nur der Injektor ist
  plattformspezifisch (CGEvent statt SendInput). Scancode Set 1 bleibt das
  Wire-Format, der Mac-Host mappt auf seine Keycodes.
