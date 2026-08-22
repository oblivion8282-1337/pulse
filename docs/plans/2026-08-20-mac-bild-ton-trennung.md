# macOS: Bild und Ton entkoppeln (zwei SCStreams)

> **Für agentische Bearbeiter:** ERFORDERLICHE UNTER-SKILL: `superpowers:subagent-driven-development` (empfohlen) oder `superpowers:executing-plans`. Schritte tragen Checkbox-Syntax (`- [ ]`).

**Ziel:** Auf macOS bestimmt der Ton-Wunsch nicht länger mit, was im Bild zu sehen ist.

**Aufbau:** Statt eines `SCStream`, dessen einziger Inhaltsfilter Bild **und** Ton zugleich zuschneidet, laufen zwei: einer fürs Bild (Filter allein nach Bildwunsch), einer für den Ton (Filter allein nach Ton-Wunsch, Bild verworfen). Die Aufrufer merken davon nichts — `Capturer::start` und `Capturer::stop` behalten ihre Signatur.

**Technik:** Rust, `objc2` + ScreenCaptureKit. macOS 15.7.3 auf der Entwicklungsmaschine.

**Zweig:** `feat/mac-bild-ton-trennung` (von `feat/gemeinsame-bausteine`)

## Das Problem, in einem Satz

ScreenCaptureKit nimmt **einen** `SCContentFilter` für Bild und Ton zusammen. Der Code sagt es selbst (`capture/mod.rs:502`):

```
// The SCK content filter scopes video AND audio together, so the audio
// mode also shapes what's captured visually
```

Daraus folgen zwei Fehler, die der Nutzer am 2026-08-20 gemeldet hat:

1. **Ton einer App wählen schrumpft das Bild auf diese App.** Wer den Monitor überträgt und als Tonquelle Safari wählt, sendet nur noch Safari. Ursache: `AudioScope::App(x)` baut `initWithDisplay_includingApplications_exceptingWindows` — der Filter schneidet auch das Bild zu.
2. **Pulse ist im eigenen Monitor-Stream unsichtbar.** Um kein Echo zu erzeugen, wird Pulse aus dem Ton ausgeschlossen (`excludingApplications`) — und verschwindet damit zwangsläufig auch aus dem Bild. Der Nutzer will die App aber sehen.

## Globale Randbedingungen

- **Nie direkt auf `main`.** Landen nur über PR via `bash scripts/ship.sh`. Merge = Prod-Deploy, braucht Freigabe. **Kein `git push` ohne Freigabe.**
- **Die Signatur von `Capturer::start` und `Capturer::stop` bleibt unverändert.** Die Trennung ist eine Innensache des Capturers; `stream_controller.rs` wird nicht angefasst.
- **Rust-Doc-Kommentare in `streaming/` sind ASCII** (`ae`/`oe`/`ue`/`ss`). **Commit-Messages mit ECHTEN Umlauten** (ä/ö/ü/ß). **Keine Emojis.**
- **Keine neuen Abhängigkeiten.** Alles Nötige liegt in `objc2-screen-capture-kit`, das bereits eingebunden ist.
- Quelldateien ≤ 350 Zeilen (hart 500). **`capture/mod.rs` hat bereits 661** — vorbestehend. Diese Änderung macht sie länger; **Aufgabe 3 splittet sie deshalb**, statt das Problem zu vergrössern.
- **Alle Befehle im Vordergrund**, kein `run_in_background`.
- Bauen und testen:
  ```
  cd /Users/michael/Documents/pulse/streaming/mac-hq-sidecar
  export PKG_CONFIG_PATH="$HOME/src/ffmpeg-openssl/lib/pkgconfig:$PKG_CONFIG_PATH"
  cargo test && cargo build --release
  ```

## Das grösste Risiko, vorab benannt

**Die Lippensynchronität hängt an den Zeitstempeln.** `stream_controller.rs:213` begründet:

> A/V sync anchors on the capture timestamps (CMSampleBuffer PTS — the same host clock for video + audio), NOT on processing time. Using emit/drain wall-clock skewed audio ~300ms late.

Bild und Ton kommen künftig aus **zwei** Streams. Die Annahme „dieselbe Host-Uhr" muss weiter gelten — ScreenCaptureKit stempelt alle Streams aus der Mach-Host-Uhr, sie sollte also halten. **Aber sie ist nicht bewiesen**, und ein Fehler hier ist nicht am Code zu sehen, sondern nur am fertigen Stream. Deshalb steht der Lippensynchronitäts-Test in „Von Hand prüfen" ganz oben und ist **nicht optional**.

## Dateiübersicht

| Datei | Verantwortung | Aufgabe |
|---|---|---|
| `src/capture/filter.rs` (neu) | baut Bild- und Ton-Filter, je aus ihrem eigenen Wunsch | 1 |
| `src/capture/mod.rs` | hält zwei Streams statt einem | 2 |
| `src/capture/output.rs` (neu) | `FrameOutput`, aus `mod.rs` herausgelöst | 3 |

---

## Aufgabe 1: Die Filter-Erzeugung herauslösen und entkoppeln

**Dateien:**
- Erstellen: `src/capture/filter.rs`
- Ändern: `src/capture/mod.rs` (Filterbau entfällt dort)

**Interfaces:**
- Erzeugt: `pub(crate) fn bild_filter(content, display_index, window_id) -> Result<Retained<SCContentFilter>>`
- Erzeugt: `pub(crate) fn ton_filter(content, display_index, audio_scope, pulse_pid) -> Result<Retained<SCContentFilter>>`

**Der Kern der ganzen Änderung** ist, dass diese beiden Funktionen einander nicht kennen.

- [ ] **Schritt 1: `bild_filter` — kennt nur den Bildwunsch**

Zwei Fälle, mehr nicht:
- `window_id: Some(id)` → `initWithDesktopIndependentWindow` (unverändert aus dem heutigen Code).
- sonst → **der ganze Bildschirm, ohne jeden Ausschluss**: `initWithDisplay_excludingWindows` mit leerem Fenster-Array.

**Das ist die eigentliche Behebung beider gemeldeten Fehler.** Weder `AudioScope::App` noch die Echo-Ausschlussliste dürfen hier noch vorkommen. Wenn du in dieser Funktion das Wort `audio` schreibst, ist etwas falsch.

- [ ] **Schritt 2: `ton_filter` — kennt nur den Ton-Wunsch**

Nimm die heutige Logik aus `mod.rs:518-561`, aber **ohne** den `window_id`-Zweig:
- `AudioScope::App(name)` → `initWithDisplay_includingApplications_exceptingWindows` mit dieser App. Nicht gefunden → derselbe Fehlertext wie heute (`App '{name}' nicht gefunden (läuft sie?)`).
- `AudioScope::Desktop { exclude }` → `initWithDisplay_excludingApplications_exceptingWindows` mit den ausgeschlossenen Apps **plus Pulse** (Elternprozess, `getppid()`), gegen Echo. Ist die Liste leer → `initWithDisplay_excludingWindows`.
- `AudioScope::None` → kommt hier nicht vor (der Aufrufer ruft die Funktion dann gar nicht); gib `None` zurück oder mach den Fall unerreichbar, aber **nicht** stillschweigend einen Vollfilter.

- [ ] **Schritt 3: Doc-Kommentar, der das Warum trägt**

Der Modulkopf von `filter.rs` muss festhalten, **warum** es zwei Funktionen sind — mit dem Zitat der SCK-Einschränkung und den beiden Fehlern, die daraus entstanden. Wer die beiden später „aus Symmetriegründen" wieder zusammenlegt, baut beide Fehler neu ein. Nenn die Symptome konkret: Ton-Quelle Safari zeigte nur noch Safari; Pulse war im eigenen Stream unsichtbar.

- [ ] **Schritt 4: Bauen** (`cargo build`) — noch nicht verdrahtet, muss aber übersetzen.

- [ ] **Schritt 5: Committen**

---

## Aufgabe 2: Zwei Streams im Capturer

**Dateien:**
- Ändern: `src/capture/mod.rs` (`Capturer::start`, `Capturer::stop`, `struct Capturer`)

**Interfaces:**
- Verbraucht: `bild_filter`, `ton_filter` aus Aufgabe 1.
- **`Capturer::start` und `stop` behalten ihre heutige Signatur.**

- [ ] **Schritt 1: `struct Capturer` fasst zwei Streams**

Heute hält er einen `stream` und ein `_output`. Künftig einen Bild-Stream und **optional** einen Ton-Stream (`Option<…>`, denn ohne Ton gibt es ihn nicht) samt dessen Output. Beide brauchen die `AssumeSend`-Hülle wie bisher.

- [ ] **Schritt 2: Bild-Stream aufbauen**

Wie heute, aber mit `bild_filter` und **ohne jede Audio-Einstellung**: kein `setCapturesAudio`, kein `setSampleRate`, kein `setChannelCount`, kein `setExcludesCurrentProcessAudio`. Es wird **nur** `SCStreamOutputType::Screen` registriert.

Der Output bekommt den Video-Kanal und **kein** Audio (siehe Schritt 4).

- [ ] **Schritt 3: Ton-Stream aufbauen — nur wenn Ton gewünscht ist**

Eigene `SCStreamConfiguration` mit `ton_filter`:
- `setCapturesAudio(true)`, `setSampleRate(48_000)`, `setChannelCount(2)`, `setExcludesCurrentProcessAudio(true)` — alles wie heute.
- **Bild so klein und selten wie möglich**: `setWidth(2)`, `setHeight(2)`, `setMinimumFrameInterval` auf 1 fps, `setQueueDepth(3)`. ScreenCaptureKit verlangt eine Bildkonfiguration, auch wenn niemand die Bilder abholt — wir halten sie deshalb winzig, statt sie zu ignorieren.
- **Nur `SCStreamOutputType::Audio` registrieren**, keinen Screen-Output. Ohne Abnehmer liefert SCK keine Bilder.

Setz einen Kommentar an die 2×2-Stelle, der erklärt, warum dort nicht die echte Auflösung steht — sonst „repariert" das jemand.

- [ ] **Schritt 4: `FrameOutput` darf auch ohne Video-Kanal leben**

`FrameOutput::new(video_tx, audio_tx)` verlangt heute einen Video-Sender. Der Ton-Stream hat keinen. **Mach den Video-Kanal optional** (`Option<Sender<Frame>>`) statt einen Wegwerf-Kanal zu erzeugen — ein Kanal, dessen Empfänger niemand leert, ist eine Falle, auch wenn hier nie etwas hineinliefe.

`handle_video` muss den Fall dann sauber überspringen.

- [ ] **Schritt 5: Beide starten, und zwar mit Rückweg bei Fehlschlag**

Beide Streams brauchen den `startCaptureWithCompletionHandler`-Ablauf mit Zeitgrenze wie heute.

**Wichtig:** Scheitert der Ton-Stream, muss der bereits gestartete Bild-Stream wieder gestoppt werden, bevor der Fehler nach oben geht. Sonst bleibt eine laufende Bildschirmaufnahme ohne Besitzer zurück — und die nächste Aufnahme kann daran scheitern (genau dieses Muster hat am 2026-08-20 dazu geführt, dass macOS die Quellenliste nicht mehr lieferte).

- [ ] **Schritt 6: `stop()` stoppt beide**

Erst den Ton-Stream, dann den Bild-Stream, beide mit der bestehenden Zeitgrenze. **Ein Fehlschlag beim ersten darf den zweiten nicht überspringen** — sonst bleibt eine Aufnahme hängen.

- [ ] **Schritt 7: Bauen und testen**

```
cd /Users/michael/Documents/pulse/streaming/mac-hq-sidecar
export PKG_CONFIG_PATH="$HOME/src/ffmpeg-openssl/lib/pkgconfig:$PKG_CONFIG_PATH"
cargo test && cargo build --release
```

- [ ] **Schritt 8: Rauchtest ohne echte Aufnahme**

```
printf '{"op":"health","id":1}\n{"op":"list_monitors","id":2}\n' | ./target/release/pulse-mac-hq-sidecar
```

Erwartung: beide `ok: true`, Bildschirm gefunden. **Kein `{"op":"start"}`** — das öffnet eine echte Aufnahme.

- [ ] **Schritt 9: Committen**

---

## Aufgabe 3: `capture/mod.rs` entlasten

**Dateien:**
- Erstellen: `src/capture/output.rs`
- Ändern: `src/capture/mod.rs`

**Hintergrund.** `mod.rs` hatte vor dieser Änderung 661 Zeilen — bei einer Projektgrenze von 350 (hart 500). Aufgabe 2 macht sie länger. Diese Aufgabe holt das zurück, **ohne Verhalten zu ändern**.

- [ ] **Schritt 1: `FrameOutput` samt `OutputIvars`, `handle_video`, `handle_audio` und `interleave_audio` nach `output.rs` verschieben**

**Wortgleich verschieben, nicht umbauen.** Die Doc-Kommentare tragen Messwissen (etwa zur Ton-Verschachtelung) und müssen mitgehen. Sichtbarkeiten nur so weit erweitern, wie der Umzug es zwingend verlangt.

- [ ] **Schritt 2: Zeilen zählen**

```
wc -l src/capture/*.rs
```

Erwartung: keine Datei über 500; nenn die Zahlen im Bericht. Bleibt `mod.rs` über 350, sag es, statt es zu verschweigen.

- [ ] **Schritt 3: Bauen und testen** wie oben.

- [ ] **Schritt 4: Committen**

---

## Von Hand prüfen — ohne das ist die Änderung nicht fertig

Automatisch prüfbar ist hier fast nichts: Es geht um zwei Aufnahmen des echten Bildschirms.

1. **Lippensynchronität** (das benannte Hauptrisiko). Ein Video mit sichtbarem Sprecher übertragen und beim Zuschauer prüfen, ob Ton und Bild zusammenpassen. **Wenn der Ton versetzt ist, tragen die beiden Streams keine gemeinsame Zeitbasis** — dann anhalten und berichten, nicht am Versatz herumschrauben.
2. **Der gemeldete Fehler 1:** Monitor übertragen, als Tonquelle Safari wählen. **Das Bild muss der ganze Monitor bleiben**, nicht auf Safari zusammenschrumpfen.
3. **Der gemeldete Fehler 2:** Monitor übertragen mit Desktop-Ton. **Pulse selbst muss im Bild sichtbar sein.**
4. **Kein Echo:** Bei laufender Sprachverbindung übertragen. Die anderen Teilnehmer dürfen sich **nicht** im Stream hören. Das ist die Eigenschaft, für die der Ausschluss ursprünglich da war — sie muss erhalten bleiben.
5. **Fenster-Aufnahme** unverändert: ein einzelnes Fenster übertragen, es bleibt bei diesem Fenster.
6. **Ohne Ton** übertragen — dann darf gar kein zweiter Stream entstehen.

## Abschluss

`superpowers:finishing-a-development-branch`. **Merge nach `main` ist ein Prod-Deploy und braucht Freigabe.**
