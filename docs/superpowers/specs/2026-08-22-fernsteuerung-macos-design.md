# Fernsteuerung auf macOS — Entwurf

Datum: 2026-08-22
Zustand: abgestimmt, noch nicht umgesetzt
Verbindlich daneben: `docs/plans/2026-08-12-input-wire-protokoll-v2.md` (Frame-Format,
Sicherheitszusagen). Dieses Dokument ergänzt es um die macOS-Seite und um die
gemeinsame Kiste; es ersetzt nichts daraus.

## 1. Ausgangslage

Die Fernsteuerung ist über den Serverweg gebaut (`remote_input`-Op auf der
App-WebSocket, Gateway reicht Frames unangetastet durch) und läuft heute nur mit
einem **Windows-Host**. Der Wunsch: derselbe Funktionsumfang mit einem
**macOS-Host**.

Was auf dem Mac bereits steht — mehr, als es zunächst aussieht:

* **Die Steuernden-Seite läuft.** `pulse-player/src/fernsteuerung/tasten.rs` bildet
  winit-Tastenkennungen ohne Plattformbezug auf Windows-Scancodes Satz 1 ab, und
  `mac-build.yml` baut den Player mit. Ein Mac kann heute schon einen
  Windows-Rechner steuern.
* **Protokoll, Gateway und Electron-Brücke sind plattformfrei.**
  `desktop/electron/remoteInputHost.ts` kennt keine Plattform,
  `sidecar.ts::getSidecar(slot)` fährt auch unter darwin je Stream-Platz einen
  eigenen Prozess, und der Gateway parst Frames grundsätzlich nicht.
* **Die Fähigkeitsauskunft läuft schon durch.** `health.gsr.remote_input`
  (`win-hq-sidecar/src/ops/health.rs:92`) → `stream.fernsteuerbar`
  (`web/src/lib/stream/state.svelte.ts:216`) → beim Zuschauer über die
  WHEP-Antwort (`hqStreamManager.svelte.ts:455`). Der Mac muss sie nur ehrlich
  beantworten; das Gating beim Zuschauer besteht bereits.

Es fehlt also die **Host-Hälfte im mac-Sidecar** und zwei harte
Plattformabfragen im Renderer (`web/src/lib/remote/darfStandplatzSein.ts` prüft
`window.pulse.os === 'win32'`, `web/src/lib/remote/session.svelte.ts:346` prüft
`isWindows()`).

Die Wire-Spezifikation hat den Fall vorgesehen: „Mac später: gleiche Frames, nur
der Injektor ist plattformabhängig (`CGEventPost` statt `SendInput`). Scancode
Satz 1 bleibt das Übertragungsformat."

## 2. Entscheidungen

| Frage | Entscheidung | Grund |
|---|---|---|
| Umfang | **Volle Parität** zu Windows | Der Mac soll nicht die halbe Funktion tragen. |
| Zeiger | **Cursor-Echo mit selbsttätigem Rückfall** | Siehe §6 — der öffentliche Weg ist abgekündigt, der private eine Wette. Der Rückfall macht das Altern harmlos. |
| Codeaufteilung | **Gemeinsame Kiste sofort** (`streaming/pulse-fernsteuerung`) | Die Sitzungs-Zustandsmaschine trägt die Sicherheitszusagen; eine zweite Kopie liefe still auseinander. |
| Sender-Seite | **Der Player linkt mit** | Beseitigt einen unbewachten Zwilling und macht einen Hin-und-zurück-Test möglich. |
| Accessibility-Freigabe | **Hinnehmen, live prüfen, ehrlich melden** | Kein Signatur-Umbau in diesem Zuschnitt; Stufe B bleibt ein eigener Entschluss. |

### 2.1 Zwei Wege, die ausdrücklich verworfen sind

**Die private CGS-Schnittstelle.** `CGSCurrentCursorSeed`,
`CGSGetGlobalCursorData`, `CGSGetCurrentCursorLocation` und
`CGSHardwareCursorActive` sind auf dieser Maschine (macOS 15.7.3) als Symbole
vorhanden und wären der strukturell exakte Windows-Entwurf: ein billiger
Wechsel-Zähler plus rohes Bitmap. Sie sind undokumentiert und können mit jeder
macOS-Fassung brechen, wobei der Bruch erst beim Nutzer auffiele. Nicht
verwendet. Hier festgehalten, damit niemand sie ein zweites Mal entdecken muss.

**Ein „Fern-Modus"-Takt im mac-Sidecar** („Senden bei Ankunft" statt festem
Bildtakt). Auf Windows gilt das ausdrücklich nur für den D3D11-Zero-Copy-Weg;
Linux, D3D12 und der CPU-Pfad takten weiter starr. Der Mac bleibt damit im
Bestand und nicht hinter der Parität zurück.

## 3. Aufbau: `streaming/pulse-fernsteuerung`

Neue plattformfreie Kiste. Die Tests der ausgelagerten Module wandern mit und
laufen damit ab sofort **auf jeder Maschine** — die Auslagerung ist belegbar,
ohne dass ein Windows-Rechner sie gesehen hat.

| Modul | Herkunft | Inhalt |
|---|---|---|
| `format` | neu, aus beiden Seiten zusammengezogen | Opcodes, feste Längen, `PROTOKOLL_VERSION`, Knopf-Nummerierung, Rad-Raste (120), die Liste der erlaubten Satz-1-Scancodes |
| `rahmen` | `win-hq-sidecar/src/remote_input/rahmen.rs` | Parser (`InputFrame::parse`, `ParseError`) |
| `bauen` | `pulse-player/src/fernsteuerung/rahmen.rs` | Frame-Bau, ohne Heap, `Copy` |
| `druck` | win | Gedrückt-Menge |
| `base64` | win | Kodierung |
| `zuordnung` | win, entwindowst | `Rechteck`-Struktur statt `RECT`; `anteil_auf_punkt`, `klemmen`, `mitte` |
| `bewegung` | win, aus `wache.rs` | `bewegung_zaehlt` samt Schwelle und Zeitfenster |
| `sitzung` | win, aus `remote_input/mod.rs` | die Zustandsmaschine samt aller Zusagen |
| `ausfuehrung` | win | was injiziert wird, Orts-Tor, Freigabe-Ausnahme |
| `vorrang` | win | Übergänge, Meldung, Freigabe |

### 3.1 Der Plattform-Schnitt

Drei schmale Traits, gehalten als `&'static dyn` statt generisch: der heiße Pfad
sind höchstens rund 900 Ereignisse je Sekunde, dynamische Auflösung ist dort
bedeutungslos — ein generischer `Sitzung<P>` zöge sich dagegen durch jede
Windows-Datei und blähte den Umstellungs-Diff auf.

* **`Injektor`** — `maus_setzen(punkt, &Druck)`, `maus_knopf(btn, down)`,
  `maus_rad(dv, dh)`, `taste(scan, down)`. Ein unbekannter Knopf und ein
  missgeformter Scancode liefern `Err` und bleiben damit fail-closed.
  **Die Gedrückt-Menge geht mit**, weil macOS sie zweimal braucht (§4).
* **`Wache`** — `starten() -> Result<(), String>`, `stoppen()`,
  `host_regt_sich()`, `rest_ms()`. `Err` beim Starten heißt: die Zusage ist auf
  diesem System nicht zu halten, die Sitzung wird verweigert.
* **`Umgebung`** — `ziel(slot) -> Zielsuche`, `host_zeiger_zeigen(bool)`,
  `melden(serde_json::Value)`.

Zwei Nebenwirkungen, beide erwünscht: die Tests der Kiste brauchen eine
**ausdrückliche Prüfstands-Plattform** statt der heutigen
`#[cfg(not(test))]`-Abfangerei in `injektion.rs` (klarer, und hermetisch auf
jeder Maschine), und `zeigerform.rs` bleibt vollständig plattformeigen, weil
Windows benennt und der Mac Bilder schickt — gemeinsam sind dort nur der
Wechselfilter und die Ein-Sekunden-Wiederholung.

### 3.2 Was plattformeigen bleibt

Windows: `injektion` (`SendInput`, `PULSE_MARKE`, DPI-Bewusstsein), das
Haken-Gerüst der Wache, die Rechteck-Auflösung in `ziel.rs`
(`GetMonitorInfoW`/DWM), `zeigerform`/`zeigerpixel`/`zeigerpunkte`,
`cursorsteuerung` sowie `zuordnung::virtueller_desktop` und
`punkt_auf_absolut` — die Normierung auf 0..65535 ist eine `SendInput`-Eigenheit,
macOS bekommt Punkte direkt.

Player: `tasten.rs` (winit → Satz 1) bleibt beim Player, denn die Kiste soll
nicht von winit abhängen. Die **Vokabelliste** dagegen zieht in `format` (§7.3).

### 3.3 Verhalten bleibt gleich

Die Auslagerung ist eine Umschichtung, keine Änderung: Zusagen, Zustandsnamen
(`live`, `unknown_slot`, `unresolved_source`, `masked`, `host_active`, `ended`),
Fehlermeldungen und die Reihenfolge der Prüfungen bleiben wortgleich. Bricht ein
Test nach der Umschichtung, ist der Code kaputt, nicht der Test.

## 4. Der macOS-Injektor

`streaming/mac-hq-sidecar/src/remote_input/injektion.rs`. Eine `CGEventSource`
einmal erzeugt, jedes Ereignis mit `kCGEventSourceUserData = PULSE_MARKE`
gestempelt, abgefeuert auf `kCGHIDEventTapLocation`. Das Stempelfeld ist das
exakte Gegenstück zu `dwExtraInfo` — die ganze Begründung aus `wache.rs`
(„ohne die Marke sperrt sich die Fernsteuerung mit ihrer ersten Mausbewegung
selbst aus") gilt wortgleich.

Die Bindungen sind vorhanden: `objc2-core-graphics` ist bereits Abhängigkeit des
mac-Sidecars und trägt `CGEventCreateMouseEvent`, `CGEventCreateKeyboardEvent`,
`CGEventCreateScrollWheelEvent2`, `CGEventPost`, `CGEventTapCreate`,
`CGEventTapEnable` und `EventSourceUserData`. Es sind nur die Merkmale
`CGEvent`, `CGEventSource` und `CGEventTypes` zuzuschalten — **keine neue
Abhängigkeit**.

Drei Dinge, die Windows nicht kennt:

**Ziehen ist ein eigener Ereignistyp.** Eine Bewegung bei gedrücktem Knopf muss
als `LeftMouseDragged` / `RightMouseDragged` / `OtherMouseDragged` gehen, nicht
als `MouseMoved` — sonst zieht in vielen Programmen nichts. Deshalb bekommt
`maus_setzen` die Gedrückt-Menge.

**Doppelklicks.** `kCGMouseEventClickState` muss beim zweiten Klick auf 2 stehen,
sonst gibt es kein Doppelklick-Markieren. Windows zählt selbst. Umgesetzt als
kleiner reiner Zähler (Zeit- und Ortsfenster) neben dem Injektor — testbar, und
unschädlich, falls die Messung (§9) zeigt, dass der WindowServer es doch tut.

**Umschalttasten.** Jedes macOS-Tastenereignis trägt ein Flag-Feld. Am HID-Punkt
sollte der WindowServer es aus dem echten Tastenzustand füllen; tut er es nicht,
setzen wir es über `CGEventSetFlags` aus unserer eigenen Gedrückt-Menge — wieder
derselbe Wert, den der Injektor ohnehin bekommt.

**Rad:** `CGEventCreateScrollWheelEvent2` mit Zeileneinheit, eine
Windows-Raste (120) = eine Zeile. Vorzeichen und das Verhalten bei „natürlichem
Scrollen" werden gemessen (§9), nicht angenommen.

**Tastentabelle** Satz 1 → `kVK_*` in `remote_input/tasten.rs`, rein und mit
Tests.

**Der mac-Sidecar bleibt zwischen Streams warm** (anders als Windows, wo
`sidecar.ts` nach jedem `stop` einen frischen Prozess fährt). Für die
Slot-Auflösung heißt das: `strom_gestartet`/`strom_beendet` müssen vom
`stream_controller` sauber gepaart gerufen werden, sonst zielt eine
Fernsteuerung auf einen Stream, den es nicht mehr gibt. Auf Windows deckt das
heute nebenbei der Prozesswechsel ab.

**Grenzen der Injektion**, dokumentiert und kein Fehler (Gegenstück zu
Strg+Alt+Entf und Fenstern höherer Integrität): Cmd+Tab und Mission Control
gehen an den WindowServer; ein sicheres Eingabefeld (`EnableSecureEventInput`)
sperrt die Tastatur aus.

## 5. Die Wache

`CGEventTapCreate` **hörend** (`kCGEventTapOptionListenOnly`) auf
`kCGSessionEventTap`, auf einem eigenen Faden mit eigener CFRunLoop; gestoppt
über `CFRunLoopStop`. Beobachtet werden Bewegung, alle Maustasten, Rad,
Tastendrücke und Flag-Wechsel. Die eigene Spur wird an `PULSE_MARKE` erkannt;
**fremde** Injektion gilt wie auf Windows bewusst als Host.

Die Aufteilung aus `wache.rs` gilt wortgleich und aus demselben Grund: der
Rückruf legt nur einen Zeitstempel ab und fasst nie die Sitzungssperre an, die
Übergänge laufen auf einem getrennten Wecker-Faden. Auch macOS hängt einen zu
langsamen Tap ab.

**Ein Punkt ist besser als auf Windows.** macOS meldet das Abhängen als
`kCGEventTapDisabledByTimeout` in den Rückruf, und `CGEventTapEnable` stellt den
Tap wieder her. Damit schließt sich genau das Restrisiko, das `wache.rs` heute
als „hier notiert statt weggeschwiegen" führt.

Der Berechtigungs-Riegel kommt geschenkt: ohne Accessibility entsteht der Tap
gar nicht erst, `Wache::starten()` liefert `Err`, und der Handschlag verweigert
die Sitzung — die Windows-Doktrin („unerfüllbar heißt Startverweigerung, nicht
still etwas Schwächeres") greift ohne eine Zeile Zusatzcode.

## 6. Der Zeiger

### 6.1 Warum der Windows-Entwurf hier nicht trägt

Auf dieser Maschine (macOS 15.7.3) nachgemessen:

* `NSCursor.currentSystemCursor` **funktioniert prozessübergreifend** — der
  Prüfling las den I-Balken, den das Terminal gesetzt hatte (9×18,
  Aufhängepunkt 4,9).
* Es ist aber **abgekündigt**, und der SDK-Header sagt wörtlich: *„This property
  will always be `nil` in a future version of macOS."* Die Ersatzempfehlung ist
  ausdrücklich: ScreenCaptureKit benutzen und den Zeiger über `showsCursor` im
  Bild lassen.
* **Die Namenszuordnung ist tot.** Der Windows-Trick (Handle gegen
  `LoadCursorW(IDC_*)` vergleichen, Namen übertragen, winit setzt die lokale
  Entsprechung) hat kein Gegenstück: `NSCursor.arrow.image` und
  `NSCursor.iBeam.image` liefern Größe (0,0) und gar kein Bild — ausgerechnet
  die beiden häufigsten Formen sind nicht wiedererkennbar.

### 6.2 Der Entwurf

Abfrage am Wecker der Wache (kein eigener Faden, wie auf Windows), Kennung als
FNV-1a über die Pixel, Versand **immer als Bild** über die vorhandene Kiste
`pulse-zeigerbild`. Gerendert wird die **einfache** Auflösung, nicht die
doppelte: winit skaliert eigene Zeiger nicht mit, ein 2x-Bild erschiene beim
Steuernden doppelt groß, und der 5900-Byte-Trichter würde eng. Bei Vorrang des
Hosts wird wie auf Windows `default` gemeldet.

Zwei Selektoren über den vorhandenen `objc2`-Laufzeitaufruf, AppKit nur
verlinkt — keine neue Kisten-Abhängigkeit.

### 6.3 Der Rückfall

Liefert die Abfrage `nil` oder ein leeres Bild, schaltet der Sidecar auf
`showsCursor = true` (`SCStream.updateConfiguration`, Bindung vorhanden, Merkmal
`block2` ist bereits gesetzt) und meldet das dem Steuernden über ein **neues
Signal** `kind: "zeiger_im_bild"`. Dessen Player blendet daraufhin seinen
**lokalen** Zeiger über dem Bild aus — der Host-Zeiger reitet dann im Video mit,
ist von Natur aus formrichtig und läuft der Hand um die Strömungsverzögerung
hinterher.

Schlechter, nicht kaputt. Das ist der Zweck: wenn Apple die Abfrage eines Tages
abschaltet, altert die Funktion, statt auszufallen.

**Synchron zu halten:** `_SIGNAL_KINDS`
(`services/chat-gateway/src/dcc_chat_gateway/routes/ws_remote_handlers.py:116`)
und `RemoteSignalKind` (`web/src/lib/ws/handlers/types.ts:30`).

### 6.4 Prüfstein

`streaming/zeigerbild-formen.json` stammt heute vom Windows-Sender. Der
mac-Sender erzeugt dieselben zwei Ausprägungen — Kurzform `{id}` und Vollform
mit Maßen —, die vorhandenen Empfänger-Tests prüfen weiter dagegen. Dazu ein
mac-seitiger Sender-Test, der belegt, dass **beide** Ausprägungen entstehen. Die
Lehre von 2026-08-17 gilt unverändert: die Masse gehören zu den Daten, nicht zur
Kennung, und ein Test auf der Empfängerseite allein hätte den Fehler nicht
gefunden.

## 7. Renderer, Electron, Berechtigung

### 7.1 Aus Plattform wird Fähigkeit

`darfStandplatzSein.ts` und `session.svelte.ts:346` prüfen die
Plattform. Beides wird durch die **Fähigkeit** ersetzt, nicht um `'darwin'`
erweitert: `darfStandplatzSein.ts` wird damit plattformfrei, und ein Mac ohne
Accessibility bietet sich gar nicht erst als Standplatz an, statt sich als
„bereit" zu melden und jede Übernahme ins Leere laufen zu lassen — genau der
Fehler, gegen den die Datei 2026-08-18 angelegt wurde.

### 7.2 Die Fähigkeit ist auf dem Mac eine Abfrage, keine Zusage

`health.gsr.remote_input` steht auf Windows fest auf `true`, weil das Op zum
Programm gehört. Auf dem Mac wird es **live geprüft** (Accessibility kann
jederzeit entzogen werden). Ein Standplatz-Mac, dessen Freigabe nach einem
Update nicht mehr gilt, verschwindet damit ehrlich aus der Liste, statt eine
Zusage zu machen, die er nicht hält.

Der Anstoß zur Freigabe gehört in den Electron-Hauptprozess
(`systemPreferences.isTrustedAccessibilityClient(prompt)`), damit in den
Systemeinstellungen „Pulse" steht und kein Binärname — **sofern** die Zuordnung
so läuft; das ist Messung 1 in §9.

### 7.3 Die Vokabelliste

`format` führt die Liste der Scancodes, die auf der Leitung vorkommen dürfen.
Der Player prüft, dass er nur daraus sendet; der mac-Injektor prüft, dass er zu
jedem Eintrag ein Ziel hat. Damit ist die Frage „kann der Mac alles einspielen,
was ein Steuernder schicken kann?" ein Test und keine Durchsicht — und der
Prüfstein kommt vom Sender, wie es die Zeigerbild-Lehre verlangt.

## 8. Nicht in diesem Zuschnitt

* **Stufe B der macOS-Verpackung** (Developer-ID-Signatur, Notarisierung,
  Auto-Update). Bleibt ein eigener Entschluss; die Folge steht in §11.
* **Der Fern-Modus-Takt** im mac-Sidecar (§2.1).
* **Der P2P-Eingabeweg.** Er ist plattformfrei (DataChannel zwischen den
  Renderern) und funktioniert ohne Zutun, sobald der Serverweg steht.
* **Ein Linux-Host.** Derselbe Kern wäre danach verfügbar, aber Linux hat keine
  einheitliche Eingabe-Injektion (X11 gegen Wayland) und ist eine eigene Frage.

## 9. Drei Messungen, bevor Code entsteht

Alle drei sind an einem halben Tag zu beantworten und ändern je einen Teil des
Entwurfs. Sie gehören vor die Umsetzung, nicht in sie hinein.

1. **TCC-Zuordnung.** Erbt der vom Electron-Hauptprozess gestartete Sidecar die
   Accessibility-Freigabe von `Pulse.app`, oder verlangt er einen eigenen
   Eintrag? Entscheidet den ganzen Berechtigungs-Ablauf in §7.2.
2. **Doppelklick und Umschalttasten.** Zählt der WindowServer bei
   `kCGHIDEventTapLocation` selbst, und füllt er die Flag-Felder? Entscheidet,
   ob der Zähler aus §4 gebraucht wird.
3. **Rad-Vorzeichen und „natürliches Scrollen".** Wirkt die Systemeinstellung auf
   injizierte Ereignisse?

## 9.1 Reihenfolge

Fünf Etappen, jede für sich prüfbar und für sich zu landen:

1. **Messungen** (§9) — ändern den Entwurf, bevor Code entsteht.
2. **Gemeinsame Kiste** — anlegen, Windows und Player umstellen, Tests laufen
   hier, Windows-Bau über CI. Ohne jede Verhaltensänderung (§3.3).
3. **Eingabe und Wache auf dem Mac** — ab hier läuft die Ad-hoc-Übernahme im
   Kanal, gemessen gegen das Prüfziel.
4. **Der Zeiger** — Echo, Form als Bild, Rückfall samt neuem Signal.
5. **Renderer** — Fähigkeit statt Plattform, Standplatz-Gerät,
   Berechtigungs-Ablauf, Changelog.

Etappe 2 ist die einzige, die Windows berührt, und sie ändert dort nichts am
Verhalten. Bricht später etwas auf Windows, ist die Ursache damit eingegrenzt.

## 10. Abnahme

* **Gemeinsame Kiste:** die mitgewanderten Tests laufen auf dieser Maschine
  (`cargo test -p pulse-fernsteuerung`), dazu der neue Hin-und-zurück-Test über
  beide Richtungen des Formats.
* **Windows-Regression:** `win-build.yml` per „Run workflow" auf dem Zweig. Der
  Windows-Sidecar lässt sich auf dem Mac nicht übersetzen; das ist der einzige
  Weg, und er gehört vor den Merge.
* **Bau-Auslöser:** `bau_ausloeser.rs` und `flatpak_kisten.rs` fordern die
  Einträge für die neue Kiste in `win-build.yml`, `mac-build.yml`, `flatpak.yml`
  und im Flatpak-Manifest selbst ein — sie sind rekursiv und rechnen über die
  `Cargo.toml`. Nicht aus dem Gedächtnis nachtragen, sondern die Tests laufen
  lassen.
* **Echte Injektion ohne zweiten Rechner:** ein Vollbild-Prüfziel, das
  empfangene Ereignisse protokolliert, plus der mitwandernde Labor-Schalter
  `PULSE_LABOR_EINGABE_OHNE_STREAM`. Messlatte wie auf Windows am 2026-08-12:
  **0 px auf 8 Zielen, Scancodes identisch.** Die Windows-Lehre kommt mit — das
  Prüfziel muss **positiv** prüfen, dass es obenauf liegt, sonst sieht ein
  verdeckendes Systemfenster wie ein toter Injektor aus.
* **Zwei-Geräte-Test** nach `docs/plans/2026-08-12-zwei-geraete-test-aufbau.md`,
  Mac als Host.
* **Changelog-Eintrag**, sachlich, ohne Emojis, mit echten Umlauten.

## 11. Bekannte Grenzen

* **Die Accessibility-Freigabe bricht bei jedem Update.** Sie hängt an der
  Code-Signatur, und das mac-DMG ist nur ad-hoc signiert (`afterPack.cjs`,
  Stufe A). Der Haken in den Systemeinstellungen bleibt dabei sichtbar stehen,
  wirkt aber nicht — der Eintrag muss entfernt und neu hinzugefügt werden. Die
  Oberfläche muss das so sagen, nicht nur „Freigabe fehlt".
* **Ein Standplatz-Mac verschwindet nach einem Update wortlos** aus der Liste
  (§7.2), und es sitzt niemand davor, der den Haken neu setzt. Das ist die
  ehrliche Folge, nicht der Fehler — behoben wird sie erst von Stufe B.
* **Cmd+Tab, Mission Control und sichere Eingabefelder** sind nicht erreichbar.
* **Der Zeiger altert.** Wenn Apple `currentSystemCursor` abschaltet, greift der
  Rückfall aus §6.3: die Form bleibt richtig, der Zeiger wird träge.
* **Animierte Zeiger stehen vermutlich still** — dieselbe offene Stelle wie auf
  Windows.

## 12. Berührte Stellen

Neu: `streaming/pulse-fernsteuerung/`,
`streaming/mac-hq-sidecar/src/remote_input/` (mit `injektion`, `tasten`,
`wache`, `ziel`, `zeigerform`, `cursorsteuerung`, `berechtigung`),
`streaming/mac-hq-sidecar/src/ops/remote_input{,_end}.rs`.

Geändert: `streaming/win-hq-sidecar/src/remote_input/**` (Umstellung auf die
Kiste), `streaming/pulse-player/src/fernsteuerung/rahmen.rs` (Umstellung),
`streaming/mac-hq-sidecar/src/{dispatch,ops/mod,ops/health,capture/mod,
stream_controller}.rs`, `streaming/mac-hq-sidecar/Cargo.toml` (Merkmale, keine
neue Abhängigkeit), `web/src/lib/remote/{darfStandplatzSein.ts,session.svelte.ts}`,
`web/src/lib/ws/handlers/types.ts`,
`services/chat-gateway/.../ws_remote_handlers.py`,
`desktop/electron/{main.ts,preload.ts}` und `web/src/lib/platform/pulse.d.ts`
(Berechtigungs-Abfrage), `.github/workflows/{win,mac}-build.yml` und
`flatpak.yml` samt Flatpak-Manifest (Bau-Auslöser),
`web/static/changelog.json`.
