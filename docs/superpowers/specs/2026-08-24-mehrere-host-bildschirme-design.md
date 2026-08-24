# Mehrere Host-Bildschirme aus Sicht des Steuernden

**Stand:** 2026-08-24 · **Zustand:** Teile 1–5 umgesetzt (`feat/ziehen-ueber-die-fenstergrenze`)
**Betrifft:** Fernsteuerung, `pulse-player`, `desktop/electron`, Sidecars (nur Teil 2)

Fünf Dinge, die zusammen ein Thema sind: Wer einen fremden Rechner mit mehreren
Bildschirmen steuert, hat mehrere Player-Fenster offen — und die verhalten sich
heute wie voneinander unabhängige Fernrohre. Man kann nichts von einem ins andere
ziehen, man sieht nicht, wie die Bildschirme drüben zueinander stehen, die
Zuordnung „welches Fenster zeigt welchen Monitor" ist ratbar statt gewusst, und
die Fenster liegen auf dem eigenen Schirm irgendwie statt so wie drüben.

Die Teile sind **unabhängig auslieferbar**. Bauen in der Reihenfolge
**1 → 3 → 2 → 4 → 5** (Teil 3 ist Voraussetzung dafür, dass Teil 2 nicht lügt;
Teil 4 braucht die Anordnung aus Teil 2).

Vorgeschichte: `docs/plans/2026-08-11-fernsteuerung-neubewertung.md` hielt unter
„Grenze, bewusst akzeptiert" fest, ein Fenster von Monitor 1 nach 2 zu ziehen
gehe nicht. Dieser Entwurf hebt das auf. Das Draht-Protokoll bleibt dabei
unverändert (`docs/plans/2026-08-12-input-wire-protokoll-v2.md`).

Zeilenangaben beziehen sich auf `c88895f1`.

---

## Teil 1 — Ziehen über die Fenstergrenze

### Was heute passiert

Der Zug scheitert an drei Stationen hintereinander:

1. **Im Player-Fenster A.** Beim Mausdruck ruft winit `SetCapture`
   (winit 0.30.13, `src/platform_impl/windows/event_loop.rs:980`) — A bekommt
   Bewegung und Loslassen weiter, auch wenn der Zeiger physisch über B steht.
   Auf X11, Wayland und macOS macht das der implizite Zeigerfang des Systems.
   Die Koordinaten liegen dann aber ausserhalb von A, und `Bildlage::anteil()`
   antwortet auf alles ausserhalb des Bildes mit `None`
   (`streaming/pulse-player/src/fernsteuerung/bildlage.rs:69-81`). Es wird
   schlicht nichts gesendet.
2. **Im Player.** Jede `Erfassung` trägt genau **einen** Platz, gesetzt beim
   Einschalten (`app/eingabe.rs:48`), und stempelt ihn auf jede Nachricht
   (`app/eingabe.rs:355-360`). A kann Bildschirm 2 nicht adressieren.
3. **In Electron.** `EingabeWeiche.verteilen` verwirft still jede Nachricht mit
   abweichendem Platz (`desktop/electron/remoteInput.ts:185`).

Ergebnis: Der Host-Zeiger bleibt an der Kante von Bildschirm 1 stehen, die Taste
bleibt unten, beim Loslassen fällt das Fenster an seinen alten Platz zurück.

### Drei Umstände, die die Lösung billig machen

- **Alle Player-Fenster leben in EINEM Prozess.** `PlayerManager` hält genau ein
  Kind (`desktop/electron/player.ts:197`, `:244`, `:288`); Fenster sind
  Sitzungsnummern darin (`app/mod.rs:454`, `:479`, `:612`). Fenster A kann ohne
  Umweg wissen, wo B liegt und was darin steht.
- **Alle Fenster eines Hosts erfassen bereits**, jedes mit eigenem Platz, jedes
  mit erledigtem Handschlag (`web/src/lib/remote/components/RemoteControllerInput.svelte:97-110`).
  Bildschirm 2 ist aufnahmebereit; es redet nur niemand mit ihm.
- **Auf dem gesteuerten Rechner läuft je Platz ein eigener Sidecar-Prozess**
  (`desktop/electron/sidecar.ts::getSidecar(slot)`), jeder mit eigener Sitzung und
  eigener Buchführung über Gedrücktes (`pulse-fernsteuerung/src/druck.rs:16-21`).
  Das klingt nach einem Hindernis, ist aber keines: **der Rechner hat nur eine
  Maus.** Injiziert wird global (`SendInput` mit
  `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK`,
  `win-hq-sidecar/src/remote_input/mod.rs:58-72`; macOS `CGEventPost` auf den
  HID-Tap). Drückt Prozess 1 die Taste herunter, ist sie am ganzen Rechner unten;
  bewegt Prozess 2 danach den Zeiger, zieht das gedrückte Fenster mit. Die beiden
  müssen sich nicht kennen — der Zustand der Maus ist ihr gemeinsames Gedächtnis.

### Der Ansatz

> **Das Fenster, das den Zug begonnen hat, behält ihn und zielt um.**

Kein Übergeben zwischen zwei Fenstern, kein zweiter Handschlag, kein Zurücksetzen.
Nur das Ziel der Nachrichten wechselt.

Das ist keine Bequemlichkeit, sondern Bedingung: **ein Hello gibt alles Gedrückte
frei** (`pulse-fernsteuerung/src/sitzung.rs:364-365`). Ein Handschlag mitten im
Zug hätte die Maustaste losgelassen und die Geste zerrissen.

### Was sich ändert

**1. Neu: `streaming/pulse-player/src/fernsteuerung/nachbarn.rs`**

Reine Rechnung, ohne Fremdbezüge, mit Tests im Modul — nach dem Muster von
`bildlage.rs` daneben.

- Eingabe: ein Punkt in Desktop-Koordinaten plus die Nachbarn als
  `{ slot, fenster_ursprung, Bildlage }`.
- Ausgabe: `Option<(slot, (f64, f64))>` — Platz und Anteil im gemeinten Bild.
- Regeln:
  - Das **eigene** Fenster hat Vorrang, wenn der Punkt darin liegt (der Normalfall
    kostet dann keine Suche).
  - Sonst der Nachbar, in dessen **Bild** der Punkt liegt. Der schwarze Rand
    zählt nicht als Treffer — das erledigt `Bildlage::anteil` ohnehin.
  - **Passen mehrere, gewinnt das zuletzt fokussierte** (entschieden 2026-08-24).
    Begründung: winit gibt die Stapelreihenfolge nicht heraus, aber der Fokus ist
    ein guter Stellvertreter dafür — ein Fenster wird durch Anklicken zugleich
    fokussiert und nach vorne geholt. Im Zieh-Fall trifft die Regel sogar per
    Bauart richtig: das ziehende Fenster ist zwangsläufig das fokussierte, liegt
    also oben, und im überlappenden Bereich sieht man genau dieses. Über dem frei
    sichtbaren Teil des anderen passt ohnehin nur der andere.
  - Kein Treffer heisst „nichts senden", nicht „klemmen".

**2. `app/mod.rs::window_event` (heute L1503-1511)**

Baut heute eine `Bildlage` aus `window.inner_size()`, `session.stats` und
`render::zoom_ausschnitt`. Baut künftig zusätzlich die Nachbarliste. Dafür braucht
es je Sitzung den Fenster-Ursprung (`inner_position()`).

**Als Nachbar zählt nur eine Sitzung mit aktiver Erfassung und derselben
Fernsteuerungs-Sitzung.** Zwei Gründe: ein Fenster ohne Erfassung hat keinen
Handschlag, und Frames dorthin würden beim Host verworfen — was schlimmer ist als
nichts zu tun, weil **jede verworfene Nachricht alles Gedrückte freigibt**
(`nur_handschlag()`, `sitzung.rs:409`).

**3. `fernsteuerung/mod.rs::Erfassung`**

- Neues Feld `ziel_slot` (Vorgabe = `slot`).
- `on_window_event` rechnet die Zeigerlage in Desktop-Koordinaten um und fragt
  `nachbarn`.
- **Bei Zielwechsel wird die Warteschlange zuerst geleert.** Die Reihenfolge ist
  bedeutungstragend (`remoteInput.ts:60-61`: „ein Klick, der seine Positionierung
  überholt, landet am falschen Ort"). Zwei Ziele in einem Bündel gibt es nicht.
- `letzte_zeigerlage` führt künftig die Lage **im gemeinten Bild**. Sonst stimmt
  `zeiger_im_bild` (`mod.rs:233-242`) am Nachbarn nicht, und das **Orts-Tor** beim
  Host (`pulse-fernsteuerung/src/ausfuehrung.rs:197-201`) verwirft Knopf und Rad.
- `CursorLeft` (`mod.rs:173-175`) darf die Lage nicht mehr blind auf `None`
  setzen, solange ein Nachbar getroffen ist.

**4. `app/eingabe.rs::eingabe_ereignis`** nimmt `ziel_slot` statt `slot`.

**5. `desktop/electron/remoteInput.ts::verteilen`**

Aus „Platz muss exakt der angemeldete sein" wird „Platz muss **ein** angemeldeter
Platz **derselben** Sitzung sein"; gebündelt wird dann mit `ev.slot`.

Die ursprüngliche Schutzwirkung bleibt vollständig erhalten. Der Fehler vom
2026-08-12 (`remoteInput.ts:171-184`) war eine **0 als Vorgabewert**, die an einen
fremden, nie begrüssten Strom ging. Ein angemeldeter Platz derselben Sitzung ist
per Definition begrüsst — genau die Eigenschaft, die damals fehlte.

### Was ausdrücklich nicht angefasst wird

Draht-Format, Sidecars, chat-gateway, Server, Datenbank, Rechte. Die Platznummer
sitzt schon heute in **jeder** Nachricht (`pulse-fernsteuerung/src/huelle.rs`) —
sie wurde nur noch nie umgestellt.

### Grenzen

- **Der Host-Zeiger springt beim Übertritt**, er wandert nicht über die echte
  Bildschirmkante. Bewusst gewählt: die Alternative verlangte die Monitor-Anordnung
  des Hosts **und** ein Umsetzen der echten Maus des Steuernden, wodurch beide
  Zeiger auseinanderlaufen könnten.
- **Überlappende Player-Fenster** sind mehrdeutig; das zuletzt fokussierte
  gewinnt (Begründung oben bei `nachbarn.rs`). Teil 4 nimmt dem Fall zusätzlich
  die Schärfe, indem es die Fenster nebeneinander legt.
- **In der Lücke** zwischen den Fenstern wird nichts gesendet; der Host-Zeiger
  wartet an seiner letzten Stelle. Loslassen dort kommt trotzdem an — A hat weiter
  alle Ereignisse. Keine klemmende Taste.
- **Ein einmaliger Rückzucker am Übertritt ist möglich.** Die beiden
  Sidecar-Prozesse lesen ihre Befehle aus getrennten Pipes; ein verspätetes Bild
  vom alten Bildschirm kann den Zeiger einmal kurz zurückziehen. Kosmetisch, die
  nächste Bewegung korrigiert es. Nicht wegzudesignen, nur zu benennen.
- **Linux als gesteuerter Rechner kann das nicht** — `linux-hq-sidecar` hat gar
  kein `remote_input`. Betrifft Windows und macOS als Host.
- **Als steuernde Seite braucht es Fensterlagen, und Wayland gibt sie nicht
  heraus.** `Window::inner_position()` liefert dort `NotSupportedError`
  (winit 0.30.13, `platform_impl/linux/wayland/window/mod.rs:268`). Auf einem
  Wayland-Sitz bleibt es deshalb beim Verhalten von vorher — kein Zug über die
  Fenstergrenze, aber auch kein Fehler. Windows, macOS und X11 können es.
  (**Für Teil 4 ist derselbe Umstand schärfer:** `set_outer_position` ist unter
  Wayland ein stiller Leerlauf. Der Knopf dort muss ausgeblendet werden oder
  sagen, dass es nicht geht — sonst drückt man ihn und nichts passiert.)
- **Ein STEUERNDER Mac mit unterschiedlich skalierten Bildschirmen bekommt den
  Zug nicht** (Nachtrag, Schlussprüfung 2026-08-24). winit liefert auf macOS
  Fensterlage (`inner_position()`) UND Zeigerlage (`CursorMoved`) je in der
  Skalierung DES JEWEILIGEN Fensters (winit 0.30.13,
  `platform_impl/macos/window_delegate.rs:928-932` bzw. `view.rs:1084`) —
  anders als auf Windows und X11, wo der Desktop ein einziger Pixelraum ist.
  `ziel_bestimmen` bildet den globalen Punkt als Summe aus eigenem Ursprung
  und Fensterpunkt (in der Skalierung des EIGENEN Fensters), `nachbarn::treffer`
  zieht davon den Ursprung des Nachbarn ab (in DESSEN Skalierung) — das kürzt
  sich nur, wenn beide gleich sind. Auf einem MacBook (2×) mit externem
  1×-Monitor, der häufigsten Mac-Aufstellung, sonst: entweder kein Treffer
  oder ein Treffer an der falschen Stelle, also ein Klick beim Host dort, wo
  niemand hingezeigt hat. Der Riegel dagegen sitzt beim Einsammeln der
  Kandidaten in `app/mod.rs::window_event`: nur Fenster mit derselben
  `window.scale_factor()` wie das eigene zählen als Nachbar. Fail-closed statt
  falsch — auf so einem Aufbau bleibt es beim Verhalten von vor diesem Teil
  (kein Zug über die Fenstergrenze, aber auch kein Fehlklick).
  **Nachtrag Schlussprüfung 2 (2026-08-24): der Riegel greift ausdrücklich nur
  auf macOS** (`app/mod.rs::skalierung_taugt`, `#[cfg(target_os = "macos")]`).
  Auf Windows und X11 ist der Riegel eine no-op (immer `true`) und muss es
  bleiben: dort ist der Desktop zwar ein einziger physischer Pixelraum
  (winit macht den Prozess per-Monitor-DPI-bewusst), aber `scale_factor()`
  darf trotzdem je Fenster verschieden sein — ein Laptop-Panel auf 150 % neben
  einem externen Monitor auf 100 % ist dort die übliche Aufstellung, nicht die
  Ausnahme. Ein gemeinsamer Pixelraum bedeutet dort gerade NICHT gleichen
  `scale_factor()`. Der ursprüngliche Bau dieses Teils hatte den Riegel
  plattformübergreifend gesetzt und damit das Ziehen über die Fenstergrenze
  auf genau dieser häufigen Windows-Aufstellung lautlos abgeschaltet — auf der
  Plattform, für die Teil 1 in erster Linie gebaut ist. Gefixt, indem der
  Riegel mit demselben Fail-closed-Gedanken wie oben auf macOS beschränkt
  wurde, statt die Bedingung irgendwie zu lockern.
- **Ein GESTEUERTER Mac bekommt den Zug, verliert dabei aber den
  Zieh-Ereignistyp und die Umschalttasten-Kennzeichnung auf dem zweiten
  Bildschirm** (derselbe Nachtrag). Der Sidecar leitet den Ereignistyp
  (`LeftMouseDragged` statt `MouseMoved`) und die Modifikator-Flags aus seiner
  eigenen Menge des gerade Gedrückten ab
  (`mac-hq-sidecar/src/remote_input/abbildung.rs`, `bewegungs_typ` und
  `flags_aus`) — diese Menge liegt je Sidecar-PROZESS, und es läuft ein
  Prozess je Platz. Läuft eine Geste über zwei Plätze, hat der zweite Prozess
  eine leere Menge: er meldet `MouseMoved` statt `LeftMouseDragged` und ohne
  Modifikator-Kennzeichnung. Umschalt-, Alt- (kopieren) und Cmd-Ziehen wirken
  auf dem zweiten Bildschirm deshalb nicht — genau die Gesten, für die man
  über die Bildschirmgrenze zieht. Auf Windows tritt das nicht auf, weil der
  dortige Injektor diese Menge nicht braucht. Eine Behebung müsste Gehaltenes
  beim Zielwechsel zwischen den Prozessen nachziehen und braucht vorher eine
  Messung — ein zweites Runter-Ereignis derselben Maustaste kann als
  Doppelklick durchgehen. Eigene Entwurfsarbeit, hier nicht enthalten.

### Prüfen

- **Rust-Unit** (`nachbarn.rs`): Treffer im eigenen Fenster, Treffer im Nachbarn,
  Rand ist kein Treffer, Lücke ist kein Treffer, Überlappung, Zoom im Nachbarn,
  verschiedene Skalierungen.
- **Node-Unit** (`desktop/test/remoteInput.test.ts`, existiert): fremder Platz
  **derselben** Sitzung wird durchgelassen; fremder Platz einer **anderen**
  Sitzung wird weiterhin verworfen; unbekannter Platz wird verworfen; Bündelung
  trägt `ev.slot`.
- **Von Hand, nicht automatisierbar** (braucht zwei echte Bildschirme und eine
  echte Maus): Fenster von Bildschirm 1 nach 2 ziehen; eine Datei zwischen zwei
  Anwendungen auf verschiedenen Bildschirmen ziehen; Loslassen in der Lücke;
  Loslassen ausserhalb aller Fenster.

Angenehmer Nebeneffekt des Zuschnitts: Es wird **kein** Windows-Sidecar-Code
angefasst — der baut auf der Linux-Maschine nicht (`CLAUDE.md`, Abschnitt
Baubarkeit). Der Player baut dort sehr wohl, mit
`FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared`.

---

## Teil 3 — Eindeutige Zuordnung Strom → Bildschirm

Vorgezogen vor Teil 2, weil die Karte ohne ihn falsche Aussagen träfe.

### Die Ursache

`web/src/lib/stream/label.ts:51-56`:

```js
const idx = Number(src.slice(MONITOR_CAPTURE_PREFIX.length));   // die Nummer ist da
const mon = catalogs.monitors.find((m) => m.index === idx);
if (mon?.name) return { label: mon.name, icon: 'monitor' };     // und wird verworfen
```

Die sendende Seite nimmt die Aufnahmequelle `"Monitor: 3"`, holt sich damit den
**Namen** und wirft die **Nummer** weg. Über den Draht reist nur noch
„Dell U2723". Die Gegenseite versucht, daraus zurückzurechnen, welcher Monitor
gemeint war (`web/src/lib/devices/schirme.svelte.ts:73-79`) — bei zwei
baugleichen Geräten unmöglich, weil die Information eine Station vorher vernichtet
wurde.

Bemerkenswert: In `web/src/lib/stream/starten.ts:56-61` steht bereits der
Kommentar zu genau dieser Verwechslung („eine Kachel ‚Monitor 1', die Monitor 3
zeigt — bei mehreren Schirmen genau die Verwechslung, die er nicht bemerken
würde"). Damals wurde die eine Hälfte behoben (die Quelle richtig auflösen); die
andere — die Nummer mitschicken — blieb offen.

### Die Änderung

Die Nummer reist denselben Weg, den der Name schon geht. Der Draht-Vertrag ist
dort ausdrücklich als „Feld fehlt, wenn unbekannt" dokumentiert
(`services/media-svc/src/dcc_media_svc/streamkeys.py:130-147`) — ein zweites
optionales Feld passt exakt hinein. Keine Migration: Stream-Zustand lebt in Redis.

1. **Neu: importfreies Modul** (Vorschlag `web/src/lib/stream/quellenummer.ts`)
   mit der Auflösung `"Monitor: <n>"` → Nummer. **Grund für das eigene Modul:**
   `label.ts` importiert `./settings.svelte` und ist damit für Nodes Testläufer
   unerreichbar (die Falle steht in `CLAUDE.md`; Muster:
   `lib/remote/zeigerbildPruefung.ts`). Damit ist die Auflösung zum ersten Mal
   überhaupt prüfbar — `web/test/` hat heute keinen Test dafür.
2. `resolveStreamLabel` gibt `monitorIndex?` mit zurück, statt sie zu verwerfen.
3. `starten.ts:72-92` reicht sie an `chatApi.getStreamToken` weiter.
4. `services/chat-gateway/.../routes/streaming.py:67-70` nimmt sie als zweites
   optionales Feld neben `label` entgegen und reicht sie wie dieses nur bei
   Bedarf weiter (`:201-207`).
5. media-svc: `stream:active`-Eintrag (`streamkeys.py:47-62`) und die Kanalliste
   (`poller.py:55-67`) tragen sie mit.
6. `web/src/lib/stores/streamPresence.svelte.ts:40-48` liest sie in den
   `StreamDescriptor`.
7. `schirme.svelte.ts::passt()` vergleicht **zuerst die Nummer**, der
   Namensvergleich bleibt als Rückfall für ältere Klienten. Kein Stichtag.

Der Griff für den namenlosen Hauptbildschirm (`schirme.svelte.ts:134-141`) bleibt,
wird aber nachrangig — er ist ein Notbehelf für Ströme ohne brauchbare Angabe.

### Die Regel, die unabhängig von der Technik gilt

> **Das „HIER" wird nur behauptet, wenn die Zuordnung eindeutig ist.**

Gibt es zwei Kandidaten — zwei gleichnamige Monitore und keine Nummer, weil der
Host eine ältere Fassung fährt — zeigt die Karte die Kästchen **ohne**
Hervorhebung und darunter eine Zeile: „Bildschirm nicht eindeutig zuzuordnen".

Begründung: Der heutige Fehler ist **still**. Ein fehlendes „HIER" fällt auf und
ist harmlos; ein falsches „HIER" fällt nicht auf.

**Teil 1 hängt an dieser Zuordnung nicht.** Der Zug rechnet mit Fensterlage und
Platznummer, nie mit der Identität eines Monitors. Eine falsche Karte kann
verwirren, aber kein Fenster auf den falschen Bildschirm ziehen.

### Vertagt: eine stabile Kennung statt der Nummer

Die Nummer ist die Reihenfolge der Aufzählung; Umstecken kann sie ändern. Eine
stabile Kennung wäre besser — macOS hat sie schon (`DisplayInfo.display_id`),
Windows liefert `device_name()` (`\\.\DISPLAY1`) heute nur als Rückfall, wirklich
stabil wäre erst der EDID-Gerätepfad über `QueryDisplayConfig`.

Der Gewinn zeigt sich **nur beim Umstecken** — und dann ändert sich ohnehin die
ganze Anordnung. Nicht jetzt. Das Feld bleibt erweiterbar: es kann später eine
Kennung tragen statt einer Nummer.

---

## Teil 2 — Die Bildschirm-Karte im Overlay

Mockup: `https://claude.ai/code/artifact/746b9ddf-b989-4346-97fd-cf3a079d8f58`

### Was fehlt

Die Anordnung der Monitore wird heute **nirgends gemeldet**:

- Windows `streaming/win-hq-sidecar/src/ops/list_monitors.rs:22-54` liefert
  `{index, name, primary, width, height, refresh_hz}` — keine Position.
- macOS `DisplayInfo` (`streaming/mac-hq-sidecar/src/capture/mod.rs:80-93`) hat
  ebenfalls keinen Ursprung.
- Linux `streaming/linux-hq-sidecar/src/ops/list_monitors.rs:13` gibt eine
  **leere Liste** zurück.

Die Zahl ist auf beiden nutzbaren Plattformen einen Aufruf entfernt und wird
sogar schon benutzt: Windows fragt `GetMonitorInfoW` bei jeder Injektion
(`remote_input/ziel.rs:259-272`, dazu `capture/source.rs:375-382`), macOS ruft
`CGDisplayBounds` an derselben Stelle (`remote_input/ziel.rs:254`).

### Umfang: eingetragene Geräte

Die Bildschirmliste erreicht das Overlay heute **nur bei Standplatz-Geräten** —
`RemoteControllerInput.svelte:238` bricht ohne Geräteeintrag ab. Das bleibt so.
Für beliebige Hosts bräuchte es einen zweiten Meldeweg über `remote_signal`; die
Zeichnung im Overlay bliebe dabei unverändert, es käme nur eine Quelle dazu.

**Linux als Host bleibt aussen vor**, solange `list_monitors` dort leer ist. Das
deckt sich mit der Fernsteuerung, die dort ohnehin nicht geht.

### Der Weg der zwei Zahlen

Bestehende Kette, um `x` und `y` verbreitert. **Keine Migration** — die
Geräte-Anmeldung lebt im Arbeitsspeicher (`_DeviceRegistryMixin`), nicht in der
Datenbank.

1. `streaming/win-hq-sidecar/src/ops/list_monitors.rs` — `x`, `y` ergänzen
2. `streaming/mac-hq-sidecar/src/capture/{mod.rs,abfrage.rs}` — Ursprung ergänzen
3. `web/src/lib/stream/gsr.ts` — `GsrMonitor` um `x`, `y`
4. `web/src/lib/devices/anmeldung.svelte.ts:105-113` — verkürzt heute auf
   `{index, name, primary}`
5. `web/src/lib/ws/gateway-senders.ts:164-172` und
   `services/chat-gateway/.../device_registry.py:244` — durchreichen
6. `web/src/lib/api/devices.ts` — `DeviceMonitor` um `x`, `y`
7. `web/src/lib/remote/playerInput.ts:106-116` — `bildschirmeMelden` trägt heute
   `{index, name, open}`; dazu `x`, `y` und welcher Schirm zu **diesem** Fenster
   gehört
8. Player-Op `remote_screens` (`app/eingabe.rs:251-259`) und der Overlay-Typ
   (`overlay/typen.rs`)

### Die Zeichnung

**Neu: `streaming/pulse-player/src/overlay/schirmkarte.rs`** — Rechnung und
Zeichnung. Ein eigenes Modul, weil `fernbedienung.rs` mit 259 Zeilen dicht an der
Grenze der Grössen-Policy steht (`PLAN.md` §12.1).

- Hüllrechteck aller Monitore, massstäblich in die Menübreite eingepasst
  (264 Punkte minus 2×8 Polsterung = 248), Höhe gedeckelt.
- **Massstäblich in Grösse und Lage**: ein Hochkant-Monitor steht hochkant, ein
  4K-Schirm ist grösser als der 1080p daneben. Genau daran erkennt man seinen
  Bildschirm wieder, noch bevor man den Namen liest.
- Drei Zustände: **hier** (Akzentrahmen, `theme::PRIMARY`), **offen** (normal,
  `theme::GRUPPE_BG`), **nicht offen** (gedämpft, gestrichelt, antippbar).
- Name nur, wenn er passt; „HIER" nur, wenn Platz ist. Lieber nichts als Brei —
  Nummer und Lage tragen die Information ohnehin.
- Satz darunter: „Du schaust auf Bildschirm 2 — in der Mitte." Das
  **Richtungswort nur, wenn es die Richtung gibt**: bei zwei Monitoren
  nebeneinander „links"/„rechts", aber kein „oben"/„unten", sonst behauptet der
  Satz eine Anordnung, die es nicht gibt.
- **Antippen** (entschieden 2026-08-24):
  - *nicht offen* → `OverlayAction::RemoteScreen(index)`, der bestehende Weg
    (`fernbedienung.rs:233`). Der Schirm wird geholt.
  - *offen* → **das zugehörige Fenster kommt nach vorne.** Bei drei oder vier
    offenen Fenstern ist genau das die Not, und es kostet fast nichts: alle
    Player-Fenster leben im selben Prozess, `Window::focus_window()` genügt.
  - *das eigene Kästchen (HIER)* → nichts. Es liegt schon vorn.

  Nebenwirkung, geprüft und in Ordnung: das Hervorholen wechselt den Fokus, und
  `Focused(false)` löst im alten Fenster `alles_loslassen()` aus
  (`fernsteuerung/mod.rs:218-221`). Wer im Menü tippt, hält nichts — und beim
  Verlassen eines Fensters ist Freigeben ohnehin das Richtige.

  Damit weicht die Karte bewusst von der heutigen Regel ab, offene Schirme gar
  nicht anzubieten (`fernbedienung.rs:183-190`). Deren Begründung — „wer sein
  Fenster sucht, findet es über die Fensterverwaltung des Systems" — galt für
  eine Liste von Dingen, die man **holen** kann. In einer Karte sind die offenen
  Schirme zwangsläufig sichtbar, sonst zeigt sie die Anordnung nicht; ein
  Kästchen, das wie ein Knopf aussieht und nichts tut, wäre die schlechtere Wahl.

**Die Karte ersetzt die Liste** (`fernbedienung.rs:196-237`), sie kommt nicht
dazu. Zwei Wege zum selben Ziel liefen auseinander, und die Knöpfe „+ Dell U2723"
wären neben antippbaren Kästchen doppelt.

Der Hinweis „Alle Bildschirme sind bereits offen" (`fernbedienung.rs:205-217`,
mit guter Begründung) wird durch die Karte gegenstandslos: dass alle offen sind,
sieht man dann.

### Auffrischen

Die Anordnung kann sich ändern. Die Karte zeigt, was die Geräte-Anmeldung zuletzt
gemeldet hat; ein Umstecken kommt mit dem nächsten `device_announce` nach. Eine
veraltete Karte ist ein kosmetischer Fehler, kein gefährlicher — Teil 1 hängt
nicht an ihr.

---

## Teil 4 — „Fenster wie beim Host anordnen"

Ein Knopf im Menü am Griff, der die offenen Player-Fenster auf dem eigenen
Schirm so hinlegt, wie die Monitore beim Host hängen.

### Warum das den Kantenübergang ersetzt

In Teil 1 wurde bewusst gewählt, dass der Host-Zeiger beim Übertritt **springt**
statt über die echte Bildschirmkante zu wandern. Der Kantenübergang hätte zwei
Dinge gebraucht: die Monitor-Anordnung des Hosts (nach Teil 2 vorhanden) **und**
ein Umsetzen der echten Maus des Steuernden — und genau das ist der heikle Teil,
weil einem dabei die Hand geführt wird und die beiden Zeiger auseinanderlaufen
können.

Teil 4 erreicht dasselbe Gefühl von der anderen Seite: **nicht die Maus
versetzen, sondern die Fenster.** Liegen die Player-Fenster so wie die Monitore
drüben, dann ist die natürliche Handbewegung von A nach B bereits der
Kantenübergang. Nichts fasst die Maus an, und Teil 1 bleibt unverändert.

Nebeneffekt: es entschärft den Überlappungsfall aus Teil 1, weil ordentlich
nebeneinander gelegte Fenster sich nicht überlappen.

### Was es tut

- Hüllrechteck der Host-Monitore (aus Teil 2), proportional in die Arbeitsfläche
  **des eigenen Bildschirms** eingepasst, auf dem das Menü geöffnet wurde.
- Jedes offene Player-Fenster bekommt Lage und Grösse seines Monitors in diesem
  Massstab (`Window::set_outer_position`, `request_inner_size`).
- **Nicht offene Schirme lassen ihre Lücke stehen**, statt die übrigen
  zusammenzuschieben — sonst stimmte die Anordnung nicht mehr, und genau die ist
  der Zweck.
- **Einmalig auf Knopfdruck, kein Dauerzustand.** Eine bleibende Zwangsanordnung
  würde mit der Fensterverwaltung des Nutzers streiten.

### Grenzen

- Drei oder vier Host-Monitore auf einen eigenen Schirm gelegt ergibt **kleine
  Fenster**. Das ist die Natur der Sache und kein Fehler; wer gross will, legt
  von Hand um.
- Der Massstab richtet sich nach dem eigenen Bildschirm, nicht nach dem Host —
  die Fenster sind also nicht so gross wie drüben, nur so **angeordnet**.
- Auf einem Rechner mit mehreren eigenen Bildschirmen wird nur einer bespielt.
  Alles andere wäre eine Anordnungs-Verwaltung, und die hat das Betriebssystem.

---

## Teil 5 — Wayland: der Zug über Waylands eigenes Datengerät

**Nachgetragen am 2026-08-24**, nachdem Teil 1 auf einem Wayland-Sitz nachweislich
wirkungslos blieb.

### Warum Teil 1 dort nicht greift

Teil 1 rechnet aus Fensterlagen aus, über welchem Fenster der Zeiger steht.
Wayland gibt einer Anwendung ihre Fensterlage **grundsätzlich nicht** heraus
(`Window::inner_position()` → `NotSupportedError`, winit 0.30.13
`platform_impl/linux/wayland/window/mod.rs:268`). Der Rückfall greift sauber, aber
das Ziehen über die Fenstergrenze gibt es dort schlicht nicht.

### Der Denkfehler, und was ihn auflöst

Die Frage „**wo liegt Fenster B?**" ist nur ein Lösungsweg, nicht das Problem.
Das Problem lautet „**steht der Zeiger über Fenster B, und wo darin?**". Windows
und macOS beantworten das indirekt über Fensterlagen; **Wayland beantwortet es
direkt** — über das Datengerät des Kern-Protokolls:

```
wl_data_device.enter:
  serial · surface (welche Flaeche betreten wurde) · x, y (flaechenlokal)
```

Beim Mausdruck erklärt Fenster A dem Compositor den Beginn eines Zuges
(`wl_data_device.start_drag`). Ab da stellt der Compositor bei jeder Bewegung der
Fläche unter dem Zeiger zu, was gebraucht wird — **auch der eigenen zweiten
Fläche**, während A den Zug hält. Genau die Auskunft, die Teil 1 sich mühsam
errechnet.

### Warum das besser ist als der Windows-Weg

| | Windows/macOS (Teil 1) | Wayland (Teil 5) |
|---|---|---|
| Herkunft der Position | selbst errechnet aus Fensterlagen | vom Compositor geliefert |
| Skalierungs-Falle | ja, daher der macOS-Riegel | entfällt, Koordinaten sind flächenlokal |
| Veraltet bei verschobenem Fenster | möglich | unmöglich |
| Fenster müssen angeordnet sein | ja | nein |

### Kein winit-Patch nötig — das Muster gibt es schon

**Korrigiert am 2026-08-24 nach Belegrecherche.** Hier stand, es brauche einen
Patch an winit, der Seat und Zeigernummer herausreicht. Das ist so nicht richtig:

`streaming/pulse-player/src/tastensperre/wayland.rs` (281 Zeilen) bindet **bereits
heute** Wayland-Protokolle neben winit, und zwar vollständig ohne winit-Änderung:

- **Dieselbe Verbindung, keine zweite:** über `RawDisplayHandle::Wayland` an winits
  `wl_display`, darum ein Gast-Backend (`Backend::from_foreign_display`, das die
  Verbindung beim Abbau **nicht** schliesst). Zwingend, weil sich Objekte zweier
  Verbindungen nicht mischen lassen.
- **Eigene Ereigniswarteschlange, kein eigener Faden:** `registry_queue_init` legt
  sie an; den Socket liest weiterhin winit, libwayland verteilt beim Lesen auf
  alle Warteschlangen. Geleert wird bei Gelegenheit (`dispatch_pending`).
- **Die Fläche** wird aus dem rohen `wl_surface`-Zeiger rekonstruiert
  (`ObjectId::from_ptr` + `Proxy::from_id`), bei jeder Anforderung frisch.
- **Den Seat holt es sich selbst**, nicht von winit: es liest die Registry der
  Gast-Verbindung durch, filtert alle Globals mit Interface `wl_seat` und bindet
  **jeden einzelnen** — weil winit nicht herausgibt, welchen es selbst benutzt.

Damit ist die Seat-Frage erledigt. Offen bleibt allein die **Zeigernummer**, und
auch dafür gibt es einen Weg ohne Patch: über denselben Seat ein **eigenes**
`wl_pointer` binden, das die `button`-Ereignisse samt Nummer mitbekommt.
**Das ist noch nicht belegt** — siehe die offenen Punkte unten.

Abhängigkeiten sind vorhanden und in `Cargo.toml` begründet: `wayland-client 0.31`
(`system`), `wayland-backend 0.3` (`client_system` — nur dieses Backend hat
`from_foreign_display` und `ObjectId::from_ptr`), `wayland-protocols 0.32`. Sie
**müssen** dieselben Fassungen sein, die winit zieht, sonst wären `wl_surface`
hier und dort für den Compiler verschiedene Typen. `wl_data_device`, `wl_pointer`
und `wl_seat` liegen im Kern-Protokoll, es braucht kein neues Feature.

### Der Preis ist kleiner als gedacht: `source = null`

**Korrigiert am 2026-08-24.** Hier stand, fremde Programme sähen den Zug und
zeigten kurz ein „geht nicht"-Symbol. Das Protokoll sagt zu `start_drag`
wörtlich:

> If source is NULL, enter, leave and motion events are sent **only to the client
> that initiated the drag** and the client is expected to handle the data passing
> internally.

Genau unser Fall: Wir wollen keinen Datentransfer, nur die Auskunft „der Zeiger
ist jetzt bei x,y in dieser Fläche". Mit `source = null` entfällt damit die
`wl_data_source` samt MIME-Typen **und** die Sichtbarkeit für fremde Programme.
Das Zieh-Symbol ist ebenfalls optional (`icon` ist `allow-null`).

### Was der Compositor liefert

`wl_data_device.enter(serial, surface, x, y, id)` — `x`/`y` **flächenlokal**;
dazu `motion(time, x, y)`, `leave()` und `drop()`. Belegt ist auch der Kern der
Idee: `enter` wird gesendet, wenn der Zeiger „a surface **owned by the client**"
betritt — die eigene zweite Fläche zählt also mit. Voraussetzung: **jedes Fenster
braucht sein eigenes `wl_data_device`** für denselben Seat.

### Warum das auf Wayland sogar einfacher ist

Der Windows-Weg rechnet aus Fensterlagen aus, welches Fenster gemeint ist
(`ziel_bestimmen` → `nachbarn::treffer`). Auf Wayland entfällt diese Rechnung
**ganz**: der Compositor hat die Zuordnung schon geleistet und liefert die
Koordinaten fensterlokal. Es genügt, beim `enter`/`motion` auf einer Fläche
direkt deren eigenen Platz zu wählen und `Bildlage::anteil(x, y)` zu rufen.
`eigener_ursprung` bleibt auf Wayland ohnehin für immer `None` — es gibt keine
Kollision mit dem bestehenden Zweig.

### Gemessen am 2026-08-24 — beide Annahmen bestätigt

Die zwei tragenden Annahmen waren aus dem Protokolltext nicht belegbar und wurden
deshalb **vor** der Umsetzung gemessen: eigenständiges Wegwerf-Programm, reines
`wayland-client` in den Fassungen des Players, echte Maus-Ereignisse über
`ydotool` (uinput, keine klientseitige Simulation).

**1. Zwei `wl_pointer` auf demselben Seat bekommen dieselben Ereignisse mit
derselben Nummer.** Vier von vier beobachteten Paaren (`enter`, `button`,
`leave`, erneutes `enter`) waren nummerngleich, keine einzige Abweichung:

```
[pointer1] BUTTON serial=1529396 button=0x110 pressed=true
[pointer2] BUTTON serial=1529396 button=0x110 pressed=true
```

**2. `start_drag` akzeptiert die Nummer des zweitgebundenen Zeigers.** Mit
`source=None`, `icon=None` und der Nummer aus dem **zweiten** `wl_pointer` lief
ein vollständiger, echter Zug — kein Protokollfehler, keine Verbindungstrennung:

```
[data_device] Enter { serial: 1529397, surface: eigene wl_surface, x:1893.0, y:1092.0, id: None }
[data_device] Motion { ... }
[data_device] Drop
[data_device] Leave
```

Das `Enter` kam auf der **eigenen** Fläche — der Kern des Ansatzes, belegt.

**3. Ein Datengerät genügt für mehrere Fenster.** Nachgemessen mit zwei echten
Flächen desselben Klienten und **einem** Datengerät:

```
Enter(A) → 44x Motion quer durch A → Leave → Enter(B) → Drop → Leave
```

Damit ist auch das mehrfenstrige Ziehen belegt und nicht nur aus dem
Protokolltext hergeleitet. Der Zusammenhang ist wichtig: `wl_data_device` hängt
am **Sitzplatz**, nicht an einer Fläche — „je Fenster ein eigenes Gerät" wäre gar
kein Ausweg gewesen, sondern hätte nur die Ereignisse verdoppelt.

**Damit entfällt der winit-Patch.** Der Weg ist derselbe wie bei `tastensperre`:
Gast-Backend auf winits Verbindung, Seat und Zeiger selbst binden.

### Vier Stolpersteine aus der Messung

1. **`event_created_child` für `wl_data_device` ist Pflicht**, sonst gibt es beim
   ersten `data_offer` einen Absturz — und das kommt **schon beim Start** über
   `Selection`, nicht erst beim Ziehen. Leicht zu übersehen, wenn man das
   Datengerät nur für `start_drag` benutzt.
2. **`start_drag` beendet sofort den normalen Zeigerfokus** (`wl_pointer::Leave`
   auf beiden Objekten); er kommt erst nach `Drop`/`Leave` zurück, mit einer
   **neuen** Nummer. Alte Nummern dürfen nicht zwischengespeichert werden.
3. **Die Reihenfolge zwischen den beiden Zeiger-Objekten ist nicht zugesichert.**
   Welches man zum Abgreifen nimmt, ist egal; Code, der „bis beide es gesehen
   haben" wartet, darf sich auf keine Reihenfolge verlassen.
4. **Gemessen wurde nur auf `niri`.** Mutter, KWin und Sway sind ungeprüft. Das
   Protokoll verbietet nichts davon, aber die Zusicherung steht nirgends — beim
   ersten Bericht von einer anderen Oberfläche hier nachtragen.

**XWayland wurde ausdrücklich verworfen** (2026-08-24): es löst zwar das
Fensterlagen-Problem, aber es ist ein Sonderweg mit eigenen Nachteilen (HiDPI,
variable Bildrate), den jeder Wayland-Nutzer kennen und setzen müsste. Ebenso
verworfen: beide Host-Bildschirme in **ein** Player-Fenster zu legen — das löst
Wayland, ändert aber die Bedienung für alle und macht jeden Schirm kleiner.

### Zuschnitt

Teil 5 ersetzt auf Wayland **nur die Zielbestimmung**, nicht den Rest von Teil 1.
Warteschlange, Zielwechsel, Buchführung und die Electron-Weiche bleiben, wie sie
sind — es kommt eine zweite Quelle für „welcher Platz, welcher Anteil" daneben.
`ziel_bestimmen` ist die Naht.

---

## Reihenfolge und Auslieferung

| Schritt | Teil | Hängt ab von |
|---|---|---|
| 1 | Ziehen über die Fenstergrenze (Teil 1) | nichts |
| 2 | Eindeutige Zuordnung (Teil 3) | nichts |
| 3 | Bildschirm-Karte (Teil 2) | Teil 3 |
| 4 | Fenster wie beim Host anordnen (Teil 4) | Teil 2 |
| 5 | Wayland über das Datengerät (Teil 5) | Teil 1 |

**Windows-Version-Bump ist Pflicht** für die Teile 1, 2, 4 und 5: alle ändern
`streaming/pulse-player/**`, und das wird über den Installer ausgeliefert —
electron-updater ignoriert gleiche Versionen stillschweigend (`CLAUDE.md`).
Teil 2 ändert zusätzlich `streaming/win-hq-sidecar/**` und
`streaming/mac-hq-sidecar/**`.

**Changelog:** Teil 1 und Teil 2 sind sichtbar und gehören hinein. Teil 3 ist ein
stiller Fehlerfix, aber die falsche Kachel-Beschriftung war sichtbar — er gehört
in denselben Eintrag wie der Teil, mit dem er ausgeliefert wird.

---

## Entschieden am 2026-08-24

1. **Überlappende Player-Fenster:** das zuletzt fokussierte gewinnt. Der Fokus
   ist der Stellvertreter für „liegt oben", den winit uns nicht gibt; im
   Zieh-Fall stimmt er per Bauart. Die echte Stapelreihenfolge abzufragen wurde
   verworfen — sie bräuchte drei plattformeigene Sonderwege (unter Wayland teils
   gar nicht abfragbar) für einen Fall, den Teil 4 ohnehin entschärft.
2. **Antippen eines offenen Kästchens** holt das Fenster nach vorne; das eigene
   bleibt tot. Begründung bei Teil 2.
3. **Die Karte kommt zuerst nur ins Player-Overlay.** Die Fassung für die
   Geräteansicht der App ist ein späterer Nachzug, ausdrücklich nicht Teil dieses
   Vorhabens: Die x/y-Zahlen liegen nach Teil 2 ohnehin in `DeviceMonitor`, die
   abgeleiteten Angaben (läuft schon, welcher Strom) kommen aus
   `schirme.svelte.ts` — es bliebe fast nur das Zeichnen. Durch Warten geht also
   nichts verloren, und der Plan bleibt schlank.
4. **Kantenübergang statt Sprung:** verworfen, ersetzt durch Teil 4. Statt die
   Maus des Steuernden zu versetzen, werden die Fenster gelegt.

## Offen

- **Stabile Monitor-Kennung statt der Nummer** (Teil 3): vertagt, das Feld bleibt
  erweiterbar. Gewinn nur beim Umstecken eines Monitors.
- **Zweiter Meldeweg für beliebige Hosts** (Teil 2): heute nur eingetragene
  Geräte. Über `remote_signal` nachrüstbar, ohne die Zeichnung anzufassen.
