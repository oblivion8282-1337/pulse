# Bildschirm-Karte im Overlay — Umsetzungsplan (Teil 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Im Menü am Griff des Players zeigt eine massstäbliche Karte, wie die Bildschirme des ferngesteuerten Rechners zueinander stehen — und welchen davon dieses Fenster gerade zeigt.

**Architecture:** Die Sidecars melden zusätzlich Lage und Grösse jedes Monitors. Die Angaben reisen über die bestehende Geräte-Kette bis ins Player-Fenster. Dort zeichnet ein neues Modul die Kästchen massstäblich; die Rechnung ist rein und getestet, das Zeichnen dünn darüber.

**Tech Stack:** Rust (Sidecars Windows/macOS, `pulse-player` mit egui), TypeScript (`web/`), Python (chat-gateway)

**Spec:** `docs/superpowers/specs/2026-08-24-mehrere-host-bildschirme-design.md` (Teil 2)

**Mockup:** `https://claude.ai/code/artifact/746b9ddf-b989-4346-97fd-cf3a079d8f58` — zeigt Zustände, Beschriftung und Verhalten beim Antippen.

## Global Constraints

- **Es sind VIER Zahlen je Monitor, nicht zwei:** `x`, `y`, `width`, `height`. Ohne Grösse lässt sich nicht massstäblich zeichnen. `width`/`height` melden die Sidecars zwar schon, aber `ws_device_handlers.py::_monitore` wirft sie heute weg.
- **`MAX_MONITORS = 8`** (`ws_device_handlers.py:72`) — die Karte darf nicht mehr annehmen.
- **Grössen-Policy** (`PLAN.md` §12.1, Richtwert 350, hart 500): `streaming/pulse-player/src/overlay/mod.rs` steht bei **578** und ist damit **schon jetzt über der harten Grenze**. Dort kommt nichts dazu. `fernbedienung.rs` steht bei 259, `mac-hq-sidecar/src/capture/mod.rs` bei 399.
- **Der Windows-Sidecar baut auf dieser Maschine nicht** (kein `lib.exe`, vendored `windows-capture` fehlt). Prüfweg laut `CLAUDE.md`: `cargo check --target x86_64-pc-windows-msvc` in einem Wegwerf-Crate mit nur der `windows`-Kiste. **Der macOS-Sidecar lässt sich hier gar nicht prüfen** — das ist ein bewusstes Restrisiko und gehört in den Bericht.
- Deutsch in neuen Kommentaren, Stil der Umgebung, **keine Emojis**.
- **Version-Bump und Changelog gehören NICHT in diesen Plan** — Teil 2 wird gemeinsam mit 3, 4 und 5 ausgeliefert.
- Arbeitszweig: der bestehende `feat/ziehen-ueber-die-fenstergrenze`.

---

## File Structure

| Datei | Verantwortung |
|---|---|
| `streaming/win-hq-sidecar/src/ops/list_monitors.rs` | meldet zusätzlich `x`, `y` (Grösse ist schon drin) |
| `streaming/mac-hq-sidecar/src/capture/{mod.rs,abfrage.rs}` + `src/ops/list_monitors.rs` | dasselbe für macOS |
| `web/src/lib/stream/gsr.ts` | `GsrMonitor` um `x`, `y` |
| `web/src/lib/devices/anmeldung.svelte.ts` | **zwei** Stellen (Typ + Abbildung) |
| `web/src/lib/ws/gateway-senders.ts` | dritte Stelle mit demselben Inline-Typ |
| `services/chat-gateway/.../routes/ws_device_handlers.py` | `_monitore` lässt vier Zahlen durch statt sie zu verwerfen |
| `web/src/lib/api/devices.ts` | `DeviceMonitor` um die vier Zahlen |
| `web/src/lib/devices/schirme.svelte.ts` | `SchirmStand` trägt zusätzlich, welcher Schirm zu **diesem** Fenster gehört |
| `web/src/lib/remote/playerInput.ts` + `RemoteControllerInput.svelte` | melden die erweiterte Liste |
| `streaming/pulse-player/src/overlay/typen.rs` | `Schirm` um Lage, Grösse und „das ist dieses Fenster" |
| **Neu:** `streaming/pulse-player/src/overlay/schirmkarte.rs` | reine Rechnung (Hüllrechteck → Kästchen) **plus** das Zeichnen |
| `streaming/pulse-player/src/overlay/fernbedienung.rs` | ruft die Karte statt der Knopfliste |

---

## Task 1: Die Sidecars melden Lage und Grösse

**Files:**
- Modify: `streaming/win-hq-sidecar/src/ops/list_monitors.rs` (54 Zeilen)
- Modify: `streaming/mac-hq-sidecar/src/capture/mod.rs:80-92` (`DisplayInfo`), `streaming/mac-hq-sidecar/src/capture/abfrage.rs:66-89` (`list_displays`), `streaming/mac-hq-sidecar/src/ops/list_monitors.rs` (39 Zeilen)

**Interfaces:**
- Produces: die `list_monitors`-Antwort beider Sidecars trägt je Monitor zusätzlich `x` und `y` (ganzzahlig, Bildschirmkoordinaten). `width`/`height` sind bereits vorhanden und bleiben.

- [ ] **Step 1: Windows — Position über den Monitor-Handle**

Der Crate `windows-capture` ist auf dieser Maschine nicht vorhanden; **rate nicht**, ob `Monitor` einen Positions-Getter hat. Nimm den Weg, der im selben Crate zweimal vorgeführt ist:

- `remote_input/ziel.rs:249-251` zeigt, dass ein `Monitor` seinen Handle herausgibt: `monitor.as_raw_hmonitor()`
- `capture/source.rs:375-382` zeigt die Abfrage:

```rust
fn monitor_rect_by_handle(hmon: HMONITOR) -> Option<RECT> {
    let mut info =
        MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    unsafe { GetMonitorInfoW(hmon, &mut info) }
        .as_bool()
        .then_some(info.rcMonitor)
}
```

In `ops/list_monitors.rs` dieselbe Abfrage benutzen und `rcMonitor.left`/`.top` als `x`/`y` in das `json!` aufnehmen. `windows` ist bereits direkte Abhängigkeit des Crates. Schlägt die Abfrage fehl, **melde 0/0 und nicht gar nichts** — ein fehlendes Feld liesse die Karte raten; 0/0 ist erkennbar falsch und die Karte kann es behandeln. Kommentar dazu.

- [ ] **Step 2: macOS — Position über `CGDisplayBounds`**

`CGDisplayBounds` wird im selben Crate schon benutzt (`remote_input/ziel.rs:252-257`) und nimmt eine `CGDirectDisplayID`. `DisplayInfo.display_id` (`capture/mod.rs:86`) trägt sie bereits.

- `DisplayInfo` um `x: i64`, `y: i64` erweitern
- `list_displays` (`abfrage.rs:66-89`) füllt sie aus `CGDisplayBounds(display_id).origin`
- `ops/list_monitors.rs` nimmt sie ins JSON auf, mit denselben Feldnamen wie Windows

`capture/mod.rs` steht bei 399 Zeilen — zwei Felder sind vertretbar, aber **schau nach, ob die Datei dadurch die harte 500 reisst**, und sag es im Bericht.

- [ ] **Step 3: Prüfen, so weit es hier geht**

Beide Sidecars bauen auf dieser Linux-Maschine **nicht**. Für Windows gibt es den dokumentierten Ersatz (`CLAUDE.md`, Abschnitt Baubarkeit): ein Wegwerf-Crate mit nur der `windows`-Kiste und

```bash
cargo check --target x86_64-pc-windows-msvc
```

prüft die API-Aufrufe vollständig. Bau dir das, prüf damit **nur den neuen Aufruf** (`GetMonitorInfoW` mit `MONITORINFO`), und räum es danach weg.

Für **macOS gibt es hier keinen Ersatz.** Lies deinen Code Zeile für Zeile gegen die bestehende Nutzung in `remote_input/ziel.rs:252-269` — gleiche Importe, gleiche Typen, gleiche Umrechnung — und schreib in den Bericht, wovon du dich überzeugt hast und was ungeprüft bleibt. **Behaupte nicht, es sei geprüft.**

- [ ] **Step 4: Commit**

```bash
git add streaming/win-hq-sidecar/src/ops/list_monitors.rs streaming/mac-hq-sidecar/src/
git commit -m "feat(sidecar): list_monitors meldet auch die Lage der Bildschirme

Fuer die Bildschirm-Karte im Player. Windows ueber den Monitor-Handle
und GetMonitorInfoW — derselbe Weg, den capture/source.rs und
remote_input/ziel.rs im selben Crate schon gehen; ob windows-capture
selbst einen Positions-Getter hat, ist hier nicht pruefbar und wird
deshalb nicht geraten. macOS ueber CGDisplayBounds, das nebenan bereits
benutzt wird und die display_id nimmt, die DisplayInfo schon traegt.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Die vier Zahlen bis zum Gerät

**Files:**
- Modify: `web/src/lib/stream/gsr.ts:99-106`
- Modify: `web/src/lib/devices/anmeldung.svelte.ts:98-116` (**zwei** Stellen: Signatur-Typ L101, Abbildung L105-112)
- Modify: `web/src/lib/ws/gateway-senders.ts:163-172` (dritte Stelle mit demselben Inline-Typ)
- Modify: `services/chat-gateway/src/dcc_chat_gateway/routes/ws_device_handlers.py:101-130`
- Modify: `web/src/lib/api/devices.ts:17-23`

**Interfaces:**
- Consumes: die erweiterte `list_monitors`-Antwort aus Task 1
- Produces: `DeviceMonitor` trägt `x`, `y`, `width`, `height` (alle optional — ältere Geräte melden sie nicht)

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

Der Filter im Gateway ist die einzige Stelle mit echter Logik. Such die bestehenden Tests dazu (`grep -rln "device_announce\|_monitore" services/chat-gateway/tests/`) und häng in derselben Datei, im Stil der Nachbartests, Fälle an:

- ein Monitor **mit** allen vier Zahlen kommt vollständig durch
- ein Monitor **ohne** die Zahlen kommt weiterhin durch (ältere Geräte), nur ohne die Felder
- Unfug (Zeichenkette, `null`, Kommazahl, fehlende Felder) führt zum **Weglassen der Felder**, nicht zum Verwerfen des ganzen Monitors und nicht zu einer geratenen Zahl
- `MAX_MONITORS` bleibt wirksam

- [ ] **Step 2: Laufen lassen und scheitern sehen**

```bash
REDIS_URL=redis://localhost:6380/0 PULSE_INSTANCE_MODE=cloud uv run --all-packages pytest -q -k device
```

- [ ] **Step 3: Der Filter im Gateway**

`ws_device_handlers.py::_monitore` (L101-130) dampft heute auf drei Felder ein, mit dieser Begründung im Doc-Kommentar (L102-107): „Alles andere (Auflösung, Bildwiederholrate) stünde hier als Zahl, die niemand liest."

**Diese Begründung stimmt nicht mehr** — die Karte liest sie. Berichtige den Kommentar, statt ihn stehen zu lassen, und lass die vier Zahlen durch. Jede einzeln geprüft (ganze Zahl, plausibler Bereich), jede einzeln weggelassen, wenn sie fehlt oder Unfug ist. Negative `x`/`y` sind **gültig** (ein Monitor links vom Hauptbildschirm hat negatives `x`) — `width`/`height` müssen positiv sein.

- [ ] **Step 4: Die drei Inline-Typen im Web**

`{ index, name, primary }` steht wortgleich an drei Stellen (`anmeldung.svelte.ts` L101 und L105, `gateway-senders.ts` L166). Erweitere alle drei — oder besser: **zieh den Typ an eine Stelle** und importiere ihn, damit die vierte Erweiterung nicht wieder dreifach passieren muss. Entscheide bewusst und begründe im Kommentar.

`DeviceMonitor` (`api/devices.ts:17-23`) bekommt dieselben vier optionalen Felder.

- [ ] **Step 5: Tests**

```bash
REDIS_URL=redis://localhost:6380/0 PULSE_INSTANCE_MODE=cloud uv run --all-packages pytest -q
cd web && pnpm check
```

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/stream/gsr.ts web/src/lib/devices/anmeldung.svelte.ts web/src/lib/ws/gateway-senders.ts web/src/lib/api/devices.ts services/chat-gateway/
git commit -m "feat(devices): Lage und Groesse der Bildschirme bis zum Geraet

Der Filter im Gateway warf sie bisher weg, mit der Begruendung, es
seien Zahlen die niemand liest. Die Bildschirm-Karte liest sie —
Begruendung im Kommentar berichtigt.

Negative x/y sind gueltig: ein Monitor links vom Hauptbildschirm hat
eine negative Lage. Nur Breite und Hoehe muessen positiv sein.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Bis ins Player-Fenster, samt „das ist dieses Fenster"

**Files:**
- Modify: `web/src/lib/devices/schirme.svelte.ts` (447 Zeilen — `SchirmStand`)
- Modify: `web/src/lib/remote/playerInput.ts:106-115`
- Modify: `web/src/lib/remote/components/RemoteControllerInput.svelte:236-249`
- Modify: `streaming/pulse-player/src/overlay/typen.rs:73-86` (`Schirm`)

**Interfaces:**
- Consumes: `DeviceMonitor` mit den vier Zahlen (Task 2); `zuordnungEindeutig(device)` aus Teil 3
- Produces: `Schirm` im Player trägt `x`, `y`, `width`, `height` und `dieses_fenster: bool`

- [ ] **Step 1: Welcher Schirm gehört zu diesem Fenster?**

Im Player gibt es diese Angabe heute **nicht** — weder in `Schirm` noch im `Overlay`. Web-seitig ist sie da: `zuordnung()` in `schirme.svelte.ts:126-176` verknüpft Bildschirm-Index mit dem Strom, und die `NativePlayerSession` kennt ihren Platz (`web/src/lib/player/store.svelte.ts`, `fuerHost`/`nachFenster`).

`RemoteControllerInput.svelte` meldet die Liste heute **einmal für alle Fenster** (L242-245, dieselbe Liste an jedes). Künftig muss jedes Fenster **seine eigene** Liste bekommen, weil in jeder ein anderer Schirm als „dieses Fenster" markiert ist.

**Und die Fail-Visible-Regel aus dem Entwurf gilt hier:** ist `zuordnungEindeutig(geraet)` falsch, wird **kein** Schirm markiert. Ein fehlender Hinweis fällt auf und ist harmlos; ein falscher fällt nicht auf.

- [ ] **Step 2: Die Typen erweitern**

`SchirmStand` (`schirme.svelte.ts:47-50`) erbt von `DeviceMonitor` und hat damit die vier Zahlen automatisch. Dazu kommt je Fenster die Markierung.

`bildschirmeMelden` (`playerInput.ts:106-115`) trägt heute `{ index, name, open }` — erweitere um die vier Zahlen und die Markierung.

`Schirm` (`overlay/typen.rs:73-86`) bekommt dieselben Felder, alle mit `#[serde(default)]`, damit eine ältere Gegenstelle nichts bricht.

- [ ] **Step 3: Tests**

```bash
cd web && pnpm test:unit && pnpm check
cd streaming/pulse-player && FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared cargo test --bins
```

Erwartet: alle grün. Für die Auswahl „welcher Schirm gehört zu diesem Fenster" gehört die reine Regel in die importfreie Ecke (`settingsCatalog.ts` oder ein eigenes Modul) und bekommt einen Test — sie ist die Grundlage der Markierung.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/devices/schirme.svelte.ts web/src/lib/remote/ streaming/pulse-player/src/overlay/typen.rs
git commit -m "feat(player): jedes Fenster erfaehrt, welchen Schirm es zeigt

Die Bildschirmliste ging bisher identisch an alle Fenster. Fuer die
Karte braucht jedes seine eigene, weil darin ein anderer Schirm als
\"dieses Fenster\" markiert ist.

Ist die Zuordnung nicht eindeutig (zuordnungEindeutig aus Teil 3),
wird KEINER markiert — ein fehlender Hinweis faellt auf, ein falscher
nicht.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Die Karte zeichnen

**Files:**
- Create: `streaming/pulse-player/src/overlay/schirmkarte.rs`
- Modify: `streaming/pulse-player/src/overlay/fernbedienung.rs:183-237`
- Modify: `streaming/pulse-player/src/overlay/mod.rs` — **nur die Modulzeile**, sonst nichts (die Datei steht bei 578 Zeilen und ist damit schon über der harten Grenze von 500)

**Interfaces:**
- Consumes: `Schirm` mit Lage, Grösse und Markierung (Task 3)
- Produces:
  - `pub fn kaestchen(schirme: &[Schirm], breite: f32, hoehe_max: f32) -> Vec<(usize, egui::Rect)>` — die reine Rechnung, mit Tests
  - das Zeichnen, aufgerufen aus `fernbedienung.rs`

- [ ] **Step 1: Die reine Rechnung mit Tests**

Trenn sauber: **erst rechnen, dann malen.** Die Rechnung nimmt die Schirme und die verfügbare Breite und liefert Rechtecke — ohne egui-Kontext, ohne Zeichnen, damit sie prüfbar ist (Muster: `fernsteuerung/nachbarn.rs`, `fernsteuerung/bildlage.rs`).

Regeln, die die Tests festhalten müssen:
- Hüllrechteck aller Schirme, massstäblich in die verfügbare Breite eingepasst, Höhe gedeckelt
- **Seitenverhältnis bleibt** — ein Hochkant-Monitor steht hochkant
- die Anordnung bleibt erhalten: was beim Host links liegt, liegt in der Karte links
- ein Schirm ohne brauchbare Grösse (0 oder fehlend) fällt **heraus**, statt die Rechnung zu verderben
- negative `x`/`y` funktionieren (Monitor links vom Hauptbildschirm)
- ein einzelner Schirm füllt die Fläche, ohne durch Null zu teilen

- [ ] **Step 2: Laufen lassen und scheitern sehen**

```bash
cd streaming/pulse-player && FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared cargo test --bins schirmkarte
```

- [ ] **Step 3: Zeichnen**

Stilvorlage ist die **einzige** Stelle im Player, die von Hand malt — `fernbedienung.rs:63-88`:

```rust
let (flaeche, antwort) = ui.allocate_exact_size(egui::vec2(GRIFF, GRIFF), egui::Sense::click());
let hell = antwort.hovered() || self.fern_menue_offen;
ui.painter().rect_filled(flaeche, theme::RADIUS_MD, if hell { theme::GRIFF_BG_AKTIV } else { theme::LEISTE_BG });
```

Für Umrisse gibt es im Player **noch keinen Präzedenzfall** (`rect_stroke`/`Stroke` kommen nur als `Stroke::NONE` im Stil-Setup vor) — führ sie sauber ein, Farben ausschliesslich aus `theme::`.

Drei Zustände, wie im Mockup:
- **dieses Fenster**: Akzentrahmen (`theme::PRIMARY`), kräftiger gefüllt
- **offen, aber ein anderes Fenster**: normal (`theme::GRUPPE_BG`)
- **nicht offen**: gedämpft, gestrichelt, antippbar

Name nur, wenn er ins Kästchen passt; sonst weglassen. Nummer immer.

Darunter ein Satz („Du schaust auf Bildschirm 2 — in der Mitte"). Das **Richtungswort nur, wenn es die Richtung gibt**: bei zwei Monitoren nebeneinander „links"/„rechts", aber kein „oben"/„unten" — sonst behauptet der Satz eine Anordnung, die es nicht gibt. Die Ableitung gehört zur reinen Rechnung aus Step 1 und bekommt Tests.

- [ ] **Step 4: Das Menü umbauen**

`fernbedienung.rs:183-237` ersetzt die Knopfliste durch die Karte. Zwei Bedingungen ändern sich:

- heute erscheint die Gruppe nur bei `self.fern_schirme.len() > 1` (L198) — eine Karte mit **einem** Schirm ist sinnlos, das darf bleiben; entscheide bewusst und schreib es hin
- heute werden nur die **nicht** offenen gezeichnet (`!s.open`, L197) — die Karte zeigt **alle**; die Filterung wandert von „welche Liste" zu „welche sind antippbar"

**Antippen** (entschieden im Entwurf): nicht offen → `OverlayAction::RemoteScreen(index)` wie bisher; offen → das zugehörige Fenster nach vorne holen; das eigene Kästchen → nichts. Für „nach vorne holen" gibt es heute **keine** `OverlayAction` — leg eine an und fang sie in `app/mod.rs` neben `OverlayAction::RemoteScreen` (L1207-1212) auf. Alle Fenster leben im selben Prozess, `Window::focus_window()` genügt.

Der Hinweis „Alle Bildschirme sind bereits offen" (L211-217) wird durch die Karte gegenstandslos — dass alle offen sind, sieht man dann. Entfernen.

- [ ] **Step 5: Tests und Grössen**

```bash
cd streaming/pulse-player && FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared cargo test --bins
wc -l src/overlay/*.rs
```

Erwartet: alle grün; `fernbedienung.rs` und `schirmkarte.rs` unter 350; `overlay/mod.rs` **nicht gewachsen** (es steht schon über der harten Grenze).

- [ ] **Step 6: Commit**

```bash
git add streaming/pulse-player/src/overlay/ streaming/pulse-player/src/app/mod.rs
git commit -m "feat(player): die Bildschirme als massstaebliche Karte im Menue

Statt einer Liste von Knoepfen zeigt das Menue am Griff jetzt, wie die
Bildschirme des fernen Rechners zueinander stehen — und welchen dieses
Fenster zeigt.

Rechnung und Zeichnung getrennt: die Einpassung ins Huellrechteck ist
rein und getestet, das Malen duenn darueber. Ein Schirm ohne brauchbare
Groesse faellt heraus, statt die Rechnung zu verderben.

Antippen eines offenen Schirms holt sein Fenster nach vorne; das eigene
Kaestchen bleibt tot.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Bekannte Kanten

- **Der macOS-Teil ist hier nicht baubar.** Er bleibt bis zu einem echten Mac-Bau ungeprüft. Das gehört in den Bericht und in die Schlussprüfung — nicht stillschweigend als erledigt abhaken.
- **`MAX_MONITORS = 8`** im Gateway deckelt die Liste. Ein Rechner mit mehr Schirmen zeigt nur acht — bestehende Grenze, nicht von dieser Arbeit verursacht.
- **Die Karte veraltet**, wenn jemand am fernen Rechner die Monitore umsteckt. Sie zeigt, was die Geräte-Anmeldung zuletzt gemeldet hat; ein Umstecken kommt mit der nächsten Anmeldung nach. Kosmetisch, und Teil 1 hängt nicht daran.

## Selbstprüfung gegen den Entwurf

| Entwurf, Teil 2 | Task |
|---|---|
| Sidecars melden die Position | 1 |
| Weg über die Geräte-Kette, keine Migration | 2 |
| `DeviceMonitor` trägt die Zahlen | 2 |
| Jedes Fenster kennt seinen Schirm | 3 |
| Fail-visible: kein „HIER" bei Mehrdeutigkeit | 3 |
| Massstäbliche Kästchen, drei Zustände | 4 |
| Karte **ersetzt** die Liste | 4 |
| Antippen: holen / nach vorne / nichts | 4 |
| Eigenes Modul, `overlay/mod.rs` wächst nicht | 4 |
| Richtungswort nur, wenn es die Richtung gibt | 4 |
