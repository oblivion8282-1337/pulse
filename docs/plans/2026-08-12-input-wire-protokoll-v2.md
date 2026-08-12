# Fernsteuerung — Input-Wire-Protokoll v2 (2026-08-12)

**Verbindliche Spezifikation für beide Seiten.** Diese Datei ist
**selbsttragend**: sie enthält das vollständige Format, nicht nur die Änderungen
gegenüber v1. Wer sie liest, braucht `2026-07-22-remote-control-input-wire-protokoll.md`
nicht — das ist Absicht. v1 liegt ausschließlich auf dem Zweig
`feat/remote-control-windows` und ist damit von `main` aus unsichtbar; eine
Spezifikation, deren eine Hälfte auf einem anderen Zweig liegt, ist eine Falle.

**Wer was tut:** Der **Steuernde** (`pulse-player` bzw. Electron) erzeugt die
Frames, der **Host** (`win-hq-sidecar`) parst und injiziert sie. Der
chat-gateway reicht sie **unangetastet** durch und schaut nicht hinein.

## Warum v2

Zwei Änderungen an der Welt, beide aus der Neubewertung vom 2026-08-11
(`docs/plans/2026-08-11-fernsteuerung-neubewertung.md`):

1. **Der Serverweg trägt.** v1 setzte einen WebRTC-DataChannel voraus, weil der
   Serverweg mit „300 ms+" als unbrauchbar galt. Diese Zahl war nie gemessen;
   nachgemessen sind es rund 55–85 ms. Der Eingabeweg läuft jetzt über die
   WebSocket-Verbindung, die die App ohnehin offen hält.
2. **Mehrere Bildschirme gleichzeitig gibt es** (PR #321). v1 setzte genau eine
   Quelle voraus und hatte deshalb kein Feld dafür. Bei zwei laufenden Streams
   landete ein Klick auf dem falschen Bildschirm.

## Zwei Transportwege, ein Frame-Format

| Weg | Träger | Stand |
|---|---|---|
| **Serverweg** (Vorgabe) | `remote_input`-Op über die App-WebSocket | wird gebaut |
| **P2P** (Rückfahrkarte) | WebRTC-DataChannel, Label `input` | liegt auf `feat/remote-control-windows` |

**Das Frame-Format ist auf beiden Wegen identisch.** Nur die Hülle unterscheidet
sich. Das ist der Grund, warum P2P jederzeit wieder dazugeholt werden kann,
ohne dass Sender oder Injektor angefasst werden müssen.

Beide Wege garantieren **zuverlässig und in Reihenfolge**. Das ist keine
Bequemlichkeit: Die Reihenfolge Bewegung→Klick ist bedeutungstragend (ein Klick,
der seine Positionierung überholt, landet am falschen Ort), und ein verlorenes
Key-Up wäre eine klemmende Taste. Beim Serverweg liefert TCP das von selbst.

## Die Hülle auf dem Serverweg

```json
{
  "op": "remote_input",
  "session_id": "…",
  "slot": 0,
  "frames": ["AQAAgAAA", "AwAB"]
}
```

| Feld | Bedeutung |
|---|---|
| `session_id` | die per Consent bestätigte Sitzung |
| `slot` | **welcher Bildschirm gemeint ist** (siehe unten) |
| `frames` | ein oder mehrere Frames, Base64, **in Reihenfolge** |

Nur der **Steuernde** sendet. Der Gateway prüft Sitzung, Rolle und Größe und
reicht sonst unverändert weiter — er parst die Frames **nicht**. Das ist
bewusst: das Protokoll ein zweites Mal in Python nachzubauen hieße, es an zwei
Stellen pflegen zu müssen, und der Gateway hat keinen Nutzen davon.

**Grenzen (Flutschutz, Gateway-seitig erzwungen):** höchstens **32 Frames** je
Nachricht und **1024 Byte** dekodiert insgesamt. Darüber → Fehler 4050, Frames
verworfen, Sitzung bleibt bestehen.

**Dazu ein Deckel je Sekunde** (ergänzt 2026-08-12). Die Grenzen oben formen nur
eine *einzelne* Nachricht; ohne Takt-Deckel kostet ein Verstoß nichts, und ein
Steuernder kann mit Leitungsgeschwindigkeit sowohl das Protokoll des Gateways
als auch den Host fluten. Die Flutkontrolle des Steuernden ist normativ, aber
nicht überprüfbar — der Gateway muss sich selbst schützen. Anhaltswert: der
Steuernde gibt Bewegungen im Bildtakt ab, also grob 120 Nachrichten je Sekunde
bei 120 Hz; der Deckel liegt darüber und trennt nicht, sondern verwirft.

### Der `slot`

`slot` benennt **einen der gleichzeitig laufenden Streams des Hosts**, nicht
einen Monitor. Der Host löst ihn zur Injektionszeit in die Aufnahmequelle dieses
Streams auf und daraus in das Quell-Rechteck. Slot 0 ist der erste Stream.

**Warum in der Hülle und nicht im Frame:** Alle Frames einer Nachricht gehen
ohnehin an dasselbe Ziel, und ein Feld je Frame kostete bei 60 Bewegungen je
Sekunde ohne Gegenwert. Wichtiger: so bleibt das **Frame-Format zwischen beiden
Transportwegen wortgleich** — der DataChannel-Weg trägt den Slot dann im Hello.

**Unbekannter Slot** (kein Stream in diesem Slot) → der Host verwirft die Frames
still und beendet die Sitzung **nicht**. Das ist die eine Abweichung von
fail-closed, und sie hat einen Grund: Streams enden asynchron, ein Slot kann
zwischen Absenden und Ankunft verschwinden. Das ist ein Rennen, kein Angriff.

**„Unbekannt" schließt AUSSERHALB DES BEREICHS ein** (präzisiert 2026-08-12).
Ein Slot jenseits der Platzgrenze wird genauso still verworfen wie ein leerer.
Er darf **nicht** als Protokollfehler behandelt werden und **nicht** die Sitzung
beenden — sonst genügt ein `slot: 999`, um eine laufende Fernsteuerung
abzuwürgen, und genau das Rennen, das diese Regel tolerieren soll, fällt durch.
Der Slot darf dabei nirgends stillschweigend auf 0 zurechtgebogen werden: ein
verbogener Platz wäre ein Klick auf dem falschen Bildschirm.

**Und die Freigabe gilt auch hier.** Wird wegen unbekannten Slots, unauflösbarer
Quelle oder geschwärzten Sichtschutzes verworfen, gibt der Host trotzdem alles
Gedrückte frei. Sonst verschluckt genau dieser Pfad ein Hoch-Ereignis, und die
Taste klemmt am fremden Rechner, bis die ganze Sitzung endet — es genügt, dass
der Host sein gestreamtes Fenster minimiert.

## Frame-Format

Little-endian, Byte 0 = Opcode, feste Längen. **Unbekannter Opcode oder falsche
Länge → der Host beendet die Sitzung** (fail-closed, Begründung unten).

| Opcode | Name | Aufbau | Länge |
|---|---|---|---|
| `0x00` | Hello | `[0x00][u8 version]` | 2 B |
| `0x01` | MouseMoveAbs | `[0x01][u16 x][u16 y]` | 5 B |
| `0x02` | MouseMoveRel | `[0x02][i16 dx][i16 dy]` | 5 B |
| `0x03` | MouseButton | `[0x03][u8 btn][u8 down]` | 3 B |
| `0x04` | MouseWheel | `[0x04][i16 dv][i16 dh]` | 5 B |
| `0x05` | Key | `[0x05][u16 scan][u8 down]` | 4 B |

### Hello (`0x00`)

MUSS der **erste** Frame der Sitzung sein, `version = 2`. Alles andere zuerst,
oder eine unbekannte Version → Sitzung beenden. Der Host antwortet nicht; der
Kanal ist eine Einbahnstraße.

**Ein weiteres Hello ist erlaubt und bedeutet „neuer Eingabestrom".** Der Host
**gibt dabei alles Gedrückte frei** und beginnt mit leerem Zustand.

*Präzisiert am 2026-08-12.* Hier stand, ein zweites Hello beende die Sitzung.
Das war aus drei Gründen falsch: der Host hat es nie so umgesetzt, der
Steuernde erzeugt bei jedem Aus-/Einschalten der Erfassung legitim eines
(dieselbe Host-Sitzung, neuer Strom), und ein Beenden hätte jede Umschaltung
still stillgelegt. Als **Neuanfang mit Freigabe** gelesen ist es zugleich die
Selbstheilung gegen klemmende Tasten: wer beim Umschalten ein Hoch-Ereignis
verliert, bekommt es beim nächsten Hello zurück.

**Der Handschlag ist Sitzungszustand, keine Eingabe** (ergänzt 2026-08-12). Er
MUSS auch dann verarbeitet werden, wenn die Eingabe-Frames derselben Nachricht
verworfen werden — unbekannter Slot, noch nicht aufgelöste Quelle, schwärzender
Sichtschutz. Verworfen wird die Eingabe, nicht der Handschlag. Ohne diese Regel
gilt: wer das Hello verwirft, verwirft es endgültig, denn der Steuernde erzeugt
je Einschalten genau eines und erfährt vom Verwerfen nichts. Die nächste
Nachricht ist dann eine Bewegung, der Host geht fail-closed, und die ganze
Sitzung stirbt an einem Stream, der eine Sekunde zu spät angelaufen ist.

**v1-Sender werden abgewiesen.** Es gibt keine Übergangsfassung: v1 hat nie
ausgeliefert, es gibt also keinen Bestand, auf den Rücksicht zu nehmen wäre.

### MouseMoveAbs (`0x01`)

`x`/`y` ∈ 0..65535, normiert auf das **Videobild des gemeinten Slots** — nicht
auf den Bildschirm des Steuernden und nicht auf den Desktop des Hosts.

* **Steuernder:** Position im Bildinhalt auf `u,v ∈ [0,1]` bringen,
  `round(u*65535)` senden. Der Player kennt sein Bildrechteck genau und liefert
  über `winit` Zeigerpositionen als `f64`; Ränder außerhalb des Bildes werden
  **nicht** gesendet.

  **Der Nenner ist `Breite − 1`, nicht `Breite`** (präzisiert 2026-08-12): der
  Anteil spannt von der ersten bis zur *letzten* Bildspalte, weil der Host mit
  `px = u*(w−1)` zurückrechnet. Mit `Breite` als Nenner wächst der Fehler linear
  zum Rand, und die letzte Spalte wird nie getroffen — man kommt am fernen
  Rechner nicht in die rechte untere Ecke.

  **Nicht nur die Bewegung, auch Knopf und Rad gehören ins Bild.** Ein Klick
  außerhalb des Bildinhalts — auf einem Briefkasten-Rand oder auf der Bedienleiste
  des Players — darf **nicht** gesendet werden. Sonst kommt er beim Host an der
  Stelle an, an der der Zeiger zuletzt *im* Bild stand, also irgendwo.
* **Host:** Quell-Rechteck `R` bestimmen (siehe Koordinaten-Zuordnung),
  `px = R.left + u*(R.width-1)` (analog y), ins Rechteck klemmen, dann absolut
  injizieren mit `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK`, normiert auf
  den virtuellen Desktop.

**Anteile, nicht Pixel — und das ist geprüft** (2026-08-11). 65536 Stufen über
die Bildbreite sind selbst über vier 4K-Monitore nebeneinander noch 4,3 Stufen
je Pixel, also feiner als das Ziel. Pixelwerte verlangten dagegen, dass beide
Seiten die Geometrie des Hosts kennen und einig sind — bei Monitorwechsel,
Auflösungsstufe oder zugeschaltetem Bildschirm müsste das neu abgeglichen
werden, und jede Verzögerung dabei setzt Klicks an die falsche Stelle.

### MouseMoveRel (`0x02`)

`dx`/`dy` in Pixeln (+x rechts, +y runter).

**Der Host rechnet das Delta auf die von ihm zuletzt gesetzte Lage, klemmt ins
Quell-Rechteck und setzt absolut** (geändert 2026-08-12). Hier stand vorher
`MOUSEEVENTF_MOVE` **ohne** `ABSOLUTE`, damit Windows seine Beschleunigung
anwendet — für den Zeigerfang-Fall (Spiele) erwünscht. Das ist gestrichen,
weil es die Klemm-Zusage aushebelte: ein Delta lässt sich ohne Rückmeldung
nicht klemmen, und `GetCursorPos` nach `SendInput` ist nicht verlässlich
aktuell (Rohreingabe läuft asynchron) — ein darauf gestütztes Tor verwürfe
echte Klicks. Die Beschleunigung fällt damit weg.

**Der Weg zurück ist offen, aber teuer:** er verlangt eine belegte Rückmeldung
über die tatsächliche Zeigerlage, nicht ein ungeklemmtes `SendInput`. Praktisch
kostet die Änderung heute nichts — der Zeigerfang ist in der Auslieferung gar
nicht verdrahtet (`preload.ts` setzt `pointerLock = false`), MoveRel entsteht
also derzeit nirgends.

**Kein Protokollschalter für den Modus:** Der Steuernde sendet MoveRel genau
dann, wenn er den Zeiger gefangen hält, sonst MoveAbs. Der Host behandelt beide
zustandslos.

### MouseButton (`0x03`)

`btn`: 0=links, 1=rechts, 2=mitte, 3=X1, 4=X2. `down`: 1=runter, 0=hoch.
Host: `MOUSEEVENTF_{LEFT,RIGHT,MIDDLE}{DOWN,UP}`; X1/X2 über
`MOUSEEVENTF_X{DOWN,UP}` mit `mouseData=XBUTTON1/2`. **Unbekannter `btn` →
Sitzung beenden.**

**Ein Druck braucht eine gültige Zeigerlage im heutigen Quell-Rechteck**
(ergänzt 2026-08-12) — der Frame trägt keine eigene Position, er feuert sonst
dort, wo der Zeiger des Host-Nutzers gerade steht. Der Host behauptet die Lage
vor dem Druck neu; eine verworfene Bewegung entwertet sie. Das **Loslassen**
eines bereits vermerkten Knopfes geht immer durch, sonst klemmte die Maustaste.
Siehe „Klemmen" unter Sicherheit und Robustheit.

### MouseWheel (`0x04`)

`dv` (senkrecht) / `dh` (waagerecht) in **Windows-Rastschritten**
(`WHEEL_DELTA` = 120 je Raste). Vorzeichen in Windows-Konvention: `dv > 0` =
vom Nutzer weg. Host: `MOUSEEVENTF_WHEEL` / `MOUSEEVENTF_HWHEEL`.

Das Rad trägt wie der Knopf keine Position und unterliegt **derselben
Ortsprüfung** (ergänzt 2026-08-12) — ohne sie scrollte der Steuernde in dem
Fenster, über dem der Host-Nutzer gerade seinen Zeiger hat.

### Key (`0x05`)

`scan` = **Windows Scancode Satz 1**; erweiterte Tasten als `0xE0xx` (rechte
Strg-Taste `0xE01D`, Pfeil links `0xE04B`). Layoutunabhängig — keine Seite
braucht Wissen über die Tastaturbelegung.

* **Steuernder:** feste Tabelle von der Tastenkennung auf den Scancode.
  `Pause` hat einen `0xE1`-Präfix-Sonderfall und wird **nicht** gesendet.
* **Host:** `KEYEVENTF_SCANCODE` (plus `KEYEVENTF_EXTENDEDKEY` bei
  `0xE0`-Präfix), `wVk = 0`. Kein Mapping auf virtuelle Tasten — Scancodes gehen
  roh an `SendInput`.

## Flutkontrolle (Pflicht des Steuernden, normativ)

* Mausbewegungen zusammenfassen: höchstens **eine** Bewegung je Bildtakt;
  zwischenzeitliche Positionen verwerfen (absolut) bzw. aufsummieren (relativ).
* Staut sich der Sendepuffer, werden **nur Bewegungen** verworfen. Tasten,
  Knöpfe und Rad werden **nie** verworfen — ein verschlucktes Key-Up ist eine
  klemmende Taste, eine verschluckte Bewegung ist nichts.

Das ist wortgleich die Regel, die auch Moonlight/Sunshine fahren (dort
ausdrücklich: veraltete Mausbewegungen dürfen verworfen werden).

## Koordinaten-Zuordnung (Host)

Das Quell-Rechteck `R` wird **zur Injektionszeit** aufgelöst, nicht beim
Sitzungsstart — Fenster bewegen sich, Streams werden umgeschaltet.

* **Monitor-Aufnahme:** `rcMonitor` des aufgenommenen Monitors.
* **Fenster-Aufnahme:** `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` —
  **nicht** `GetWindowRect`. WGC nimmt die DWM-Rahmengrenzen auf; `GetWindowRect`
  liefert bei modernen Fenstern den um den unsichtbaren Anfassrand größeren
  Bereich, also einen systematischen Klickversatz von rund 7 px.
* **Vollbild-Rückfall** (Fenster gewählt, aber Monitor aufgenommen): Rechteck
  des Monitors. Solange der Sichtschutz schwärzt, wird **sämtliche Eingabe
  verworfen** — der Steuernde ist blind und darf dann auch nicht blind klicken.

**DPI-Pflicht.** Vor der ersten Injektion muss
`SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` gelaufen sein. Ohne das
sind alle Koordinaten-Schnittstellen bei Skalierung ≠ 100 % virtualisiert und
die Zuordnung systematisch falsch. Das ist die Erkenntnis aus dem M0-Prüfling
und gilt für jedes Programm, das hier misst — das Prüfziel
`streaming/win-hq-labor/testbench/eingabe-pruefziel.ps1` setzt es aus demselben
Grund.

## Sicherheit und Robustheit

* **Fail-closed.** Unbekannter Opcode, falsche Framelänge, fehlendes oder
  falsches Hello, unbekannter Knopf → Sitzung beenden und Zustand melden. Die
  Eingabe kommt vom einzigen, per Consent bestätigten Gegenüber; alles
  Missgeformte ist ein Fehler oder ein Angriff. In beiden Fällen ist Beenden
  richtiger als Raten. **Ausnahme:** unbekannter Slot (siehe oben).
* **Das Recht wird nicht nur beim Aufbau geprüft** (ergänzt 2026-08-12). Eine
  laufende Sitzung endet, sobald der Steuernde `REMOTE_CONTROL` oder
  `VIEW_CHANNEL` im Kanal verliert, aus der Community fliegt oder gebannt wird.
  Ohne das überlebt eine Fernsteuerung den Rechteentzug bis zum Ablauf des
  Zugangstokens — bei 15 Minuten Gültigkeit sind das 15 Minuten Tastaturzugriff
  auf einem fremden Rechner, nachdem ein Admin die Rolle genommen hat. Zulässig
  ist eine kurze Verzögerung (Prüfung im Takt, höchstens eine Minute); ein
  ausdrücklicher Rauswurf oder Bann muss **sofort** trennen.
* **Eine Absage hält eine Weile** (ergänzt 2026-08-12). Nach „Ablehnen" *und*
  nach dem Aussitzen einer Einladung gilt zwischen genau diesem Paar (Host,
  Steuernder) eine Sperrfrist; ein früherer Versuch wird mit **4055** und der
  Restzeit abgewiesen. Ohne sie kostet ein „Nein" nichts, und der Host lässt
  sich mit Dialogen zumüllen, bis er aus Entnervung zustimmt. Die Prüfung liegt
  **hinter** der Rechteprüfung — sonst verriete der Code einem Unberechtigten,
  dass zwischen zwei fremden Nutzern gerade eine Anfrage lief.
* **Der Steuernde muss seine Sitzung kennen, bevor der Host antwortet**
  (ergänzt 2026-08-12). Der Gateway schickt ihm dazu unmittelbar nach dem
  Anlegen und **vor** der Fächerung an die Host-Tabs
  `{"op":"remote_pending","session_id","channel_id","host_user_id"}`.
  Abgebrochen wird mit dem bestehenden `remote_end`; der Gateway setzt dabei
  dieselbe Sperrfrist wie bei einer Absage, sonst wäre die Bremse durch
  Anfragen-und-sofort-Abbrechen wirkungslos.
  **Warum das nötig ist:** ohne eigene Kennung kann der Steuernde weder
  abbrechen noch eine Antwort einer *fremden* Sitzung erkennen. Er nimmt dann
  die Zustimmung von Host A an, während seine Oberfläche längst auf Host B
  zeigt — und schickt Eingaben, die auf das Bild von B zielen, an den Rechner
  von A. Jeder eingehende `remote_*`-Frame ist deshalb gegen die gemerkte
  Kennung zu prüfen und Fremdes zu verwerfen.
* **Jeder Relay-Op des Gateways ist gedeckelt, nicht nur `remote_input`**
  (ergänzt 2026-08-12). `remote_signal` ist derselbe Weiterleiter an denselben
  Empfänger und blieb beim ersten Deckel übersehen — die Fehlerklasse ist „ein
  Peer flutet den anderen über einen Gateway-Relay-Op", nicht „`remote_input`
  ist gefährlich". Dazu eine Mindestpause zwischen zwei `remote_request`
  (Code **4056**, je Verbindung): eine Anfrage kostet drei Datenbank-Abfragen,
  eine Kleinstnachricht kostet nichts. Der Deckel ist ein **Sprungfenster**,
  kein rollendes; an der Fenstergrenze passieren also kurzzeitig zwei
  Kontingente. In Byte gerechnet ist das folgenlos, weil die gedeckelten
  Nachrichten selbst eng begrenzt sind — ein rollendes Fenster kostete je
  Verbindung eine Zeitstempelliste.
* **Eine Sitzung endet auch ohne Anlass** (ergänzt 2026-08-12). Zusätzlich zu
  jeder Untätigkeitsgrenze läuft eine absolute Höchstdauer (derzeit 8 Stunden).
  Eine Fernsteuerung, die niemand beendet — vergessenes Fenster, eingeschlafener
  Host — ist sonst unbegrenzter Zugriff, und die Zustimmung war für eine
  Sitzung gedacht, nicht für ein Dauerrecht.
* **Alles loslassen beim Ende.** Der Host führt die Menge der gedrückten Tasten
  und Knöpfe mit und injiziert bei Sitzungsende für alles Gedrückte das
  Hoch-Ereignis — egal ob regulär beendet, Verbindung weg, oder fail-closed.
  Ohne das läuft nach einem Abbruch die W-Taste im Spiel für immer weiter.
* **Klemmen.** Absolute Koordinaten werden ins Quell-Rechteck geklemmt. Der
  Steuernde kann nur dorthin klicken, wo er per Aufnahme auch hinsehen darf.
  **Das gilt für jeden Weg, nicht nur für die absolute Bewegung** (geschärft
  2026-08-12). Relative Bewegung darf das Rechteck ebenso wenig verlassen, und
  ein Knopf trägt keine eigene Position — er feuert dort, wo der Zeiger steht.
  Beides zusammen hebelte die Zusage mit zwei Frames aus: ein paar relative
  Bewegungen weit nach außen, dann ein Klick, und der Steuernde klickt auf
  einen Teil des fremden Desktops, den er nie zu sehen bekam. Derselbe Schaden
  ohne Angreifer: wird eine absolute Bewegung verworfen, feuert der nachfolgende
  Klick sonst trotzdem — an der Zeigerposition des *Host-Nutzers*. Ein Knopf
  ohne gültige, ins Rechteck geklemmte Zeigerlage geht deshalb nicht hinaus.
  Das **Loslassen** eines bereits vermerkten Knopfes bleibt davon ausgenommen,
  sonst klemmte die Maustaste. Dass der eigene Steuernde sich brav verhält, ist
  keine Durchsetzung — der Host ist die fail-closed-Grenze.
* **Grenzen der Injektion (dokumentiert, kein Fehler):** `SendInput` erreicht
  weder Strg+Alt+Entf noch Fenster mit höherer Integrität (Rechteabfragen,
  Administrator-Fenster bei nicht erhöhtem Sidecar). Die Windows-Taste geht
  durch.

## Was sich gegenüber v1 geändert hat

| | v1 | v2 |
|---|---|---|
| Träger | nur WebRTC-DataChannel | zusätzlich die App-WebSocket, und die ist die Vorgabe |
| Ziel-Angabe | keine (genau eine Quelle unterstellt) | `slot` in der Hülle |
| Frames je Nachricht | genau einer | bis zu 32 (nur Serverweg) |
| Hello-Version | 1 | 2 |
| Frame-Aufbau | — | **unverändert**, Byte für Byte |

Die letzte Zeile ist die wichtigste: Injektor und Sender bleiben zwischen den
Transportwegen austauschbar.

## Umsetzung

* **Host** (`streaming/win-hq-sidecar/src/remote_input.rs`): Parser und
  Injektor. Der Injektionscode stammt aus dem M0-Prüfling
  (`streaming/win-input-poc/`), der als eigenständige Diagnose bestehen bleibt.
  Der Zustand der gedrückten Tasten liegt hinter einem Mutex (kalt — nur bei
  Tasten- und Knopfereignissen).
* **Steuernder** (`streaming/pulse-player`): `winit` liefert Tasten und Maus
  roh, ohne Zeigerfang-Mathematik und ohne Briefkasten-Rechnerei, die eine
  Browser-Fassung bräuchte.
* **Gateway** (`services/chat-gateway/.../ws_remote_handlers.py`): reicht durch,
  prüft Sitzung, Rolle und Größe.
* **Mac später:** gleiche Frames, nur der Injektor ist plattformabhängig
  (`CGEventPost` statt `SendInput`). Scancode Satz 1 bleibt das Übertragungsformat.

## Belegt und offen

**Belegt** (2026-08-12, diese Maschine, ein Monitor 2560×1440 bei 100 %):
Injektion trifft auf 0 px genau, und ein echtes Fenster bekommt sie zugestellt —
`maus_bewegt` und `maus_taste` runter/hoch auf der gesendeten Koordinate,
gemessen mit dem Prüfziel gegen den M0-Prüfling.

**Offen:** gemischte DPI (braucht zwei Monitore mit verschiedener Skalierung),
und die Strecke über zwei Rechner.
