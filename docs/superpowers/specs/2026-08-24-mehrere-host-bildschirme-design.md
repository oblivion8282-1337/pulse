# Mehrere Host-Bildschirme aus Sicht des Steuernden

**Stand:** 2026-08-24 · **Zustand:** Entwurf, nichts gebaut
**Betrifft:** Fernsteuerung, `pulse-player`, `desktop/electron`, Sidecars (nur Teil 2)

Drei Dinge, die zusammen ein Thema sind: Wer einen fremden Rechner mit mehreren
Bildschirmen steuert, hat mehrere Player-Fenster offen — und die verhalten sich
heute wie voneinander unabhängige Fernrohre. Man kann nichts von einem ins andere
ziehen, man sieht nicht, wie die Bildschirme drüben zueinander stehen, und die
Zuordnung „welches Fenster zeigt welchen Monitor" ist ratbar statt gewusst.

Die drei Teile sind **unabhängig auslieferbar**. Bauen in der Reihenfolge
**1 → 3 → 2** (Teil 3 ist Voraussetzung dafür, dass Teil 2 nicht lügt).

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
  - Sonst der erste Nachbar, in dessen **Bild** der Punkt liegt. Der schwarze Rand
    zählt nicht als Treffer — das erledigt `Bildlage::anteil` ohnehin.
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
- **Überlappende Player-Fenster** sind mehrdeutig. Vorschlag: das zuletzt
  fokussierte gewinnt. Siehe offene Entscheidungen.
- **In der Lücke** zwischen den Fenstern wird nichts gesendet; der Host-Zeiger
  wartet an seiner letzten Stelle. Loslassen dort kommt trotzdem an — A hat weiter
  alle Ereignisse. Keine klemmende Taste.
- **Ein einmaliger Rückzucker am Übertritt ist möglich.** Die beiden
  Sidecar-Prozesse lesen ihre Befehle aus getrennten Pipes; ein verspätetes Bild
  vom alten Bildschirm kann den Zeiger einmal kurz zurückziehen. Kosmetisch, die
  nächste Bewegung korrigiert es. Nicht wegzudesignen, nur zu benennen.
- **Linux als gesteuerter Rechner kann das nicht** — `linux-hq-sidecar` hat gar
  kein `remote_input`. Betrifft Windows und macOS als Host.

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
- Antippen eines nicht offenen Schirms löst `OverlayAction::RemoteScreen(index)`
  aus — der bestehende Weg (`fernbedienung.rs:233`).

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

## Reihenfolge und Auslieferung

| Schritt | Teil | Hängt ab von |
|---|---|---|
| 1 | Ziehen über die Fenstergrenze | nichts |
| 2 | Eindeutige Zuordnung (Teil 3) | nichts |
| 3 | Bildschirm-Karte (Teil 2) | Teil 3 |

**Windows-Version-Bump ist Pflicht** für Teil 1 und Teil 2: beide ändern
`streaming/pulse-player/**`, und das wird über den Installer ausgeliefert —
electron-updater ignoriert gleiche Versionen stillschweigend (`CLAUDE.md`).
Teil 2 ändert zusätzlich `streaming/win-hq-sidecar/**` und
`streaming/mac-hq-sidecar/**`.

**Changelog:** Teil 1 und Teil 2 sind sichtbar und gehören hinein. Teil 3 ist ein
stiller Fehlerfix, aber die falsche Kachel-Beschriftung war sichtbar — er gehört
in denselben Eintrag wie der Teil, mit dem er ausgeliefert wird.

---

## Offene Entscheidungen

1. **Überlappende Player-Fenster:** Regel „zuletzt fokussiertes gewinnt"
   bestätigen — oder gibt es eine bessere?
2. **Antippen eines schon offenen Kästchens:** nichts tun, oder das Fenster nach
   vorne holen? Das heutige Menü lässt offene Schirme bewusst weg und verweist
   auf die Fensterverwaltung des Systems (`fernbedienung.rs:183-190`). In einer
   Karte sind sie zwangsläufig sichtbar — die Begründung von damals gilt für sie
   nicht mehr unverändert.
3. **Karte auch in der Geräteansicht der App?** Dieselbe Rechnung, andere
   Zeichenfläche. Nützlich, bevor man überhaupt ein Fenster öffnet — aber eine
   zweite Umsetzung, die auseinanderlaufen kann.
4. **Kantenübergang statt Sprung** (Teil 1): verworfen, nicht vergessen. Käme
   erst in Frage, wenn die Monitor-Positionen aus Teil 2 ohnehin vorliegen —
   dann fehlte nur noch das Umsetzen der echten Maus, und genau das ist der
   heikle Teil.
