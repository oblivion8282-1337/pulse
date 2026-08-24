# Wayland: der Zug über das Datengerät — Umsetzungsplan (Teil 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Das Ziehen über die Fenstergrenze funktioniert auch, wenn der steuernde Rechner auf Wayland läuft — genauso wie unter Windows und macOS.

**Architecture:** Wayland gibt einer Anwendung ihre Fensterlage nicht heraus, beantwortet die eigentliche Frage aber direkt: Beim Mausdruck erklärt das Fenster dem Compositor einen Zug (`wl_data_device.start_drag`), danach liefert er bei jeder Bewegung `enter`/`motion` an die Fläche unter dem Zeiger — **flächenlokal**, auch an die eigene zweite Fläche. Die Rechnung über Fensterlagen entfällt damit auf Wayland ganz.

**Tech Stack:** Rust, `wayland-client 0.31` (`system`), `wayland-backend 0.3` (`client_system`), `wayland-protocols 0.32` — alle bereits im Baum, in genau den Fassungen, die winit zieht.

**Spec:** `docs/superpowers/specs/2026-08-24-mehrere-host-bildschirme-design.md` (Teil 5)

## Die Messgrundlage

Die zwei tragenden Annahmen wurden am 2026-08-24 **gemessen**, mit einem eigenständigen Programm und echten Maus-Ereignissen über uinput. Beide bestätigt:

1. **Zwei `wl_pointer` auf demselben Seat bekommen dieselben Ereignisse mit identischer Nummer** — 4 von 4 Paaren, keine Abweichung.
2. **`start_drag` akzeptiert die Nummer des zweitgebundenen Zeigers.** Mit `source=None`, `icon=None` lief ein vollständiger Zug; das `Enter` kam auf der **eigenen** Fläche.

**Deshalb braucht es keinen winit-Patch.**

## Global Constraints

- **Dieselbe Verbindung wie winit, niemals eine zweite.** Objekte zweier Verbindungen lassen sich nicht mischen. Der Weg ist im Haus vorgezeichnet: `streaming/pulse-player/src/tastensperre/wayland.rs` — **lies diese Datei ganz, bevor du anfängst.** Sie löst dasselbe Problem und ist die verbindliche Vorlage.
- **Die Fassungen müssen die von winit sein**, sonst sind `wl_surface` hier und dort für den Compiler verschiedene Typen. Die Begründung steht in `streaming/pulse-player/Cargo.toml` bei den Abhängigkeiten. **Keine neuen Abhängigkeiten**, keine Versionsanhebung.
- **Nichts an Windows/macOS ändern.** Teil 5 ist ein Wayland-Zweig **neben** dem bestehenden Weg, kein Umbau. `ziel_bestimmen` bleibt für alle anderen Oberflächen, wie es ist.
- **Grössen-Policy:** Richtwert 350, hart 500 (Tests ausgenommen). `overlay/mod.rs` (579) und `app/mod.rs` (~1709) sind **schon über der harten Grenze** — dort kommt nichts dazu ausser höchstens einer Modulzeile.
- Deutsch in Kommentaren, Stil der Umgebung, **keine Emojis**.
- **Version-Bump und Changelog gehören NICHT in diesen Plan** — Teil 5 wird gemeinsam mit 1, 2, 3 und 4 ausgeliefert.
- Testbefehl: `cd streaming/pulse-player && FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared cargo test --bins`, **im Vordergrund**. Ein SIGSEGV in GPU-nahen Tests ist auf dieser Maschine Maschinenlast (ein Dev-Stack hält die GPU) — dann erneut fahren und vermerken.
- Arbeitszweig: der bestehende `feat/ziehen-ueber-die-fenstergrenze`.

## Die vier Stolpersteine aus der Messung

Diese sind **teuer erkauft** — jeder hätte sonst Zeit gekostet:

1. **`event_created_child` für `wl_data_device` ist Pflicht.** Ohne es gibt es beim ersten `data_offer` einen Absturz — und das kommt **schon beim Start** über `Selection`, nicht erst beim Ziehen. Wer das Datengerät nur für `start_drag` benutzt, übersieht es zwangsläufig.
2. **`start_drag` beendet sofort den normalen Zeigerfokus** (`wl_pointer::Leave` auf beiden Objekten). Er kommt erst nach `Drop`/`Leave` zurück, mit einer **neuen** Nummer. Alte Nummern nicht zwischenspeichern.
3. **Die Reihenfolge zwischen den beiden Zeiger-Objekten ist nicht zugesichert.** Welches man abgreift, ist egal; auf eine Reihenfolge verlassen darf man sich nicht.
4. **Gemessen wurde nur auf `niri`.** Mutter, KWin und Sway sind ungeprüft.

---

## File Structure

| Datei | Verantwortung |
|---|---|
| **Neu:** `streaming/pulse-player/src/fernsteuerung/wayland/mod.rs` | Die Gast-Verbindung: Seat, zweiter Zeiger, Datengerät. Hält die zuletzt gesehene Zeigernummer. |
| **Neu:** `streaming/pulse-player/src/fernsteuerung/wayland/zug.rs` | Den Zug beginnen und die `enter`/`motion`/`leave`/`drop`-Ereignisse in „welcher Platz, welcher Anteil" übersetzen. |
| `streaming/pulse-player/src/fernsteuerung/ziel.rs` | ein dritter Zweig in `ziel_bestimmen`, der auf Wayland vorgeht |
| `streaming/pulse-player/src/fernsteuerung/mod.rs` | Modulzeile, Feld für den Wayland-Zustand |
| `streaming/pulse-player/src/app/mod.rs` | **nur** die Stelle, an der die Gast-Verbindung aufgebaut und beim Mausdruck der Zug angestossen wird |

---

## Task 1: Die Gast-Verbindung und die Zeigernummer

**Files:**
- Create: `streaming/pulse-player/src/fernsteuerung/wayland/mod.rs`
- Modify: `streaming/pulse-player/src/fernsteuerung/mod.rs` (Modulzeile)

**Interfaces:**
- Produces:
  - `pub struct Gastverbindung` — hält Verbindung, Warteschlange, Seats, den zweiten Zeiger je Seat und das Datengerät
  - `pub fn aufbauen(window: &winit::window::Window) -> Result<Gastverbindung, String>`
  - `pub fn nachfassen(&mut self)` — Warteschlange leeren, nicht blockierend
  - `pub fn letzte_druck_nummer(&self) -> Option<u32>`

- [ ] **Step 1: Die Vorlage lesen**

`streaming/pulse-player/src/tastensperre/wayland.rs` **ganz** lesen — besonders:
- `aufbauen` (etwa Z. 222-260): `RawDisplayHandle::Wayland` → `Backend::from_foreign_display` → `Connection::from_backend` → `registry_queue_init`
- wie der Seat gebunden wird (etwa Z. 245-258): **alle** Globals mit Interface `wl_seat` aus der Registry, jedes einzeln gebunden — winit gibt nicht heraus, welchen es selbst benutzt
- `nachfassen` (etwa Z. 113-116): `dispatch_pending`, kein eigener Faden
- `flaeche` (etwa Z. 269-281): `ObjectId::from_ptr` + `Proxy::from_id`, bei jeder Anforderung frisch

**Schreib in den Modulkopf, worin sich dein Modul davon unterscheidet und worin nicht.** Wer beide später liest, soll die Gemeinsamkeit sehen und nicht raten, ob eine Abweichung Absicht war.

- [ ] **Step 2: Verbindung, Seat, zweiter Zeiger**

Nach dem Muster der Vorlage. Zusätzlich je Seat ein **eigenes** `wl_pointer` über `get_pointer` — das ist die gemessene Stelle: es bekommt dieselben `button`-Ereignisse wie winits Zeiger, mit **identischer** Nummer.

Im `Dispatch`-Handler für `wl_pointer` nur eines merken: die Nummer des letzten **Drucks** (`state == Pressed`). Alles andere wird nicht ausgewertet — winit macht die eigentliche Eingabe-Erfassung, wir brauchen ausschliesslich die Nummer.

**Nummer nicht über den Zug hinweg behalten** (Stolperstein 2): nach `Drop`/`Leave` gilt eine neue.

- [ ] **Step 3: Das Datengerät binden — mit `event_created_child`**

`wl_data_device_manager` aus der Registry binden, daraus `get_data_device(seat)`.

**Hier sitzt Stolperstein 1.** Für `wl_data_device` ist ein `event_created_child` nötig, weil das Gerät `wl_data_offer`-Kindobjekte erzeugt. Ohne das gibt es einen **Absturz beim ersten `data_offer`** — und der kommt schon beim Start über `Selection`, nicht erst beim Ziehen. In `wayland-client` geschieht das über das Makro `event_created_child!` beim `Dispatch`-Impl. Schreib einen Kommentar dazu, **warum** es da steht — sonst entfernt es später jemand, weil „wir benutzen doch gar keine Angebote".

Die `data_offer`-Objekte selbst werden nicht ausgewertet; sie müssen nur entgegengenommen werden dürfen.

- [ ] **Step 4: Übersetzen und Tests**

Es gibt hier **wenig Prüfbares** — der Grossteil ist Protokoll-Verdrahtung, die eine echte Wayland-Sitzung braucht. Was sich prüfen lässt, soll geprüft werden: etwa dass `letzte_druck_nummer` nach einem simulierten `button`-Ereignis den erwarteten Wert liefert und nach einem `Drop` wieder `None`. Wenn du dafür eine kleine reine Zustandsmaschine herausziehst, ist sie testbar — tu das, statt alles im `Dispatch` zu verweben.

```bash
cd /home/michael/Dokumente/pulse/streaming/pulse-player
FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared cargo test --bins
FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared cargo build 2>&1 | grep "^warning" || echo "keine Warnungen"
```

Erwartet: 449 grün plus deine neuen, keine neuen Warnungen.

**Auf X11 und auf Windows/macOS darf nichts davon anlaufen** — `aufbauen` gibt dort einen Fehler zurück (wie die Vorlage), und der Aufrufer behandelt ihn als „kein Wayland, alles bleibt beim Alten".

- [ ] **Step 5: Commit**

```bash
git add streaming/pulse-player/src/fernsteuerung/
git commit -m "feat(player): Gast-Verbindung fuer den Wayland-Zug

Seat und ein eigener zweiter Zeiger auf winits Verbindung, nach dem
Muster von tastensperre/wayland.rs. Der zweite Zeiger bekommt dieselben
Druck-Ereignisse mit identischer Nummer — am 2026-08-24 gemessen, und
genau diese Nummer verlangt start_drag.

event_created_child fuer wl_data_device ist Pflicht: ohne es stuerzt es
beim ersten data_offer ab, und das kommt schon beim Start ueber die
Zwischenablage, nicht erst beim Ziehen.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Den Zug beginnen und auswerten

**Files:**
- Create: `streaming/pulse-player/src/fernsteuerung/wayland/zug.rs`
- Modify: `streaming/pulse-player/src/fernsteuerung/wayland/mod.rs`

**Interfaces:**
- Consumes: `Gastverbindung` aus Task 1
- Produces:
  - `pub fn zug_beginnen(&mut self, fenster: &Window) -> bool` — `start_drag` mit `source=None`, `icon=None` und der letzten Drucknummer
  - `pub fn zeiger_ueber(&self) -> Option<(ObjectId, f64, f64)>` — welche eigene Fläche der Zeiger gerade berührt und wo darin (flächenlokal)

- [ ] **Step 1: `start_drag`**

`source = None` ist die entscheidende Wahl und **im Protokoll ausdrücklich gedeckt**:

> If source is NULL, enter, leave and motion events are sent **only to the client that initiated the drag** and the client is expected to handle the data passing internally.

Genau unser Fall — kein Datentransfer, nur die Auskunft. Und dadurch sieht **kein fremdes Programm** den Zug. `icon = None` ebenso (`allow-null`).

Die `origin`-Fläche ist die des Fensters, in dem gedrückt wurde — aus dem rohen `wl_surface`-Zeiger rekonstruiert, wie in der Vorlage.

Schlägt `start_drag` fehl oder gibt es keine Nummer, **gib `false` zurück und ändere nichts** — dann bleibt es beim bisherigen Verhalten (kein Zug über die Grenze), statt etwas Halbes zu tun.

- [ ] **Step 2: `enter` / `motion` / `leave` / `drop` auswerten**

Aus der Messung, wörtlich beobachtet:

```
[data_device] Enter { serial, surface: eigene wl_surface, x, y, id: None }
[data_device] Motion { time, x, y }
[data_device] Drop
[data_device] Leave
```

Merken: welche Fläche (`ObjectId`) und die letzte Lage darin. `leave` und `drop` räumen den Merker.

**Wichtig:** `x`/`y` sind `wl_fixed` — in `wayland-client` kommen sie bereits als `f64` an. Sie sind **flächenlokal** und beziehen sich auf die logische Grösse; wenn der Player anderswo mit physischen Punkten rechnet, ist hier eine Umrechnung mit dem Skalierungsfaktor des Fensters nötig. **Prüfe das** und schreib die Entscheidung als Kommentar hin — eine stillschweigend falsche Einheit ergibt einen Klick am falschen Ort.

- [ ] **Step 3: Eine offene Frage klären, nicht überspringen**

Die Messung lief mit **einer** Fläche. Ob **ein** Datengerät je Seat `enter` für **mehrere** Flächen desselben Klienten liefert, ist damit **nicht belegt** — das Protokoll legt es nahe (`enter` trägt die Fläche als Argument, und das ergäbe bei nur einer Fläche keinen Sinn), aber gemessen ist es nicht.

**Kläre das, bevor du darauf baust.** Entweder durch ein kurzes Wegwerf-Programm mit zwei Flächen, oder — falls das zu teuer ist — indem du je Fenster ein eigenes Datengerät anlegst; das ist sicher richtig und kostet wenig. **Schreib in den Bericht, welchen Weg du gewählt hast und warum.**

- [ ] **Step 4: Tests und Commit**

Wie in Task 1: prüfbar ist die reine Zustandsführung (welche Fläche, welche Lage, Räumen bei `leave`/`drop`) — zieh sie heraus und prüfe sie. Der Protokollteil bleibt ungeprüft; sag das im Bericht.

---

## Task 3: In die Zielbestimmung einhängen

**Files:**
- Modify: `streaming/pulse-player/src/fernsteuerung/ziel.rs`
- Modify: `streaming/pulse-player/src/fernsteuerung/mod.rs`
- Modify: `streaming/pulse-player/src/app/mod.rs` — **so wenig wie möglich** (Aufbau der Verbindung, Anstoss beim Mausdruck, `nachfassen` im Takt)

**Interfaces:**
- Consumes: `zeiger_ueber()` aus Task 2

- [ ] **Step 1: Der dritte Zweig**

`ziel_bestimmen` (`fernsteuerung/ziel.rs`) hat heute zwei Wege: mit bekanntem Fenster-Ursprung über `nachbarn::treffer`, sonst das eigene Bild. Auf Wayland ist `eigener_ursprung` **für immer `None`** — es gibt also keine Kollision.

Der Wayland-Weg ist **einfacher als beide**: Der Compositor hat die Zuordnung schon geleistet. Liegt eine Auskunft „Zeiger ist bei x,y in Fläche S" vor, wird der Platz **des Fensters zu S** genommen und `Bildlage::anteil(x, y)` **dieses** Fensters gerufen. Kein `nachbarn::treffer`, keine Desktop-Koordinaten.

Bau ihn als Zweig, der **vorgeht**, wenn eine Wayland-Auskunft vorliegt. Kommentar, warum er vorgeht und warum es keine Kollision gibt.

- [ ] **Step 2: Anstossen beim Mausdruck**

Der Zug muss beginnen, wenn eine Maustaste gedrückt wird — im selben Zug, in dem heute `knopf(..., true)` läuft. **Nur auf Wayland**, und nur, wenn die Fernsteuerung überhaupt erfasst.

**Achte auf Stolperstein 2:** `start_drag` beendet sofort den normalen Zeigerfokus. winit bekommt dann kein `CursorMoved` mehr für dieses Fenster — die Bewegungen kommen ab jetzt ausschliesslich über das Datengerät. Das ist gewollt, aber es heisst: **der Wayland-Zweig muss die Bewegung vollständig tragen**, solange der Zug läuft. Prüfe, dass nichts davon abhängt, dass parallel weiter `CursorMoved` einträfe.

- [ ] **Step 3: `nachfassen` im Takt**

Die eigene Warteschlange muss regelmässig geleert werden, sonst wächst sie (die Registry meldet weiter jedes kommende und gehende Global). Die Vorlage tut das „bei Gelegenheit". Häng dich an eine Stelle, die ohnehin regelmässig läuft — etwa dort, wo die Eingaben abgegeben werden (`app/eingabe.rs::eingaben_abgeben`).

- [ ] **Step 4: Tests, Bau, Bericht**

```bash
cd /home/michael/Dokumente/pulse/streaming/pulse-player
FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared cargo test --bins
FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared cargo build 2>&1 | grep "^warning" || echo "keine Warnungen"
```

Erwartet: alle bestehenden Tests unverändert grün — **auf dieser Maschine ändert sich nichts am Verhalten**, weil die Tests keine Wayland-Sitzung haben. Genau deshalb ist dieser Teil der am wenigsten prüfbare des ganzen Vorhabens; **sag das im Bericht deutlich**, statt Sicherheit zu suggerieren.

---

## Bekannte Kanten

- **Nur auf `niri` gemessen.** Mutter, KWin und Sway sind ungeprüft. Das Protokoll verbietet nichts davon, aber zugesichert ist es nirgends.
- **Der eigentliche Beweis ist ein Handlauf** auf einer echten Wayland-Sitzung mit zwei Player-Fenstern. Kein Test ersetzt ihn.
- **Ob ein Datengerät je Seat für mehrere Flächen genügt**, ist offen (s. Task 2, Step 3).
- **Windows und macOS bleiben unberührt** — wenn dort etwas kaputtgeht, ist die Trennung verletzt.

## Selbstprüfung gegen den Entwurf

| Entwurf, Teil 5 | Task |
|---|---|
| Gast-Verbindung auf winits Verbindung, kein Patch | 1 |
| Seat und zweiter Zeiger, Nummer abgreifen | 1 |
| `event_created_child` | 1 |
| `start_drag` mit `source=None`, `icon=None` | 2 |
| `enter`/`motion` flächenlokal auswerten | 2 |
| Dritter Zweig in `ziel_bestimmen`, ohne Kollision | 3 |
| Windows/macOS unberührt | 1–3 |
