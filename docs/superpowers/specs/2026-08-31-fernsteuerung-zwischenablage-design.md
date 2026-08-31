# Fernsteuerung — geteilte Zwischenablage (Entwurf)

Stand 2026-08-31. Voraussetzung zum Lesen: `docs/fernsteuerung.md`.
Protokoll-Bezug: `docs/plans/2026-08-12-input-wire-protokoll-v2.md`.

## Warum

Heute trägt der Eingabe-Rückweg **sechs** Rahmentypen (Hello, Maus absolut,
Maus relativ, Maustaste, Mausrad, Taste) und sonst nichts. Wer einen fremden
Rechner steuert, kann dort tippen — aber nichts von seinem eigenen Rechner
hinüberreichen. Ein Pfad, eine Fehlermeldung, ein Befehl, ein Codeschnipsel
muss abgetippt oder über den Chat geschickt werden.

Dieser Entwurf ergänzt **einen** Weg: die Zwischenablage, beidseitig, für
einfachen Text. Dateien sind ausdrücklich Stufe 2 (s. „Nicht-Ziele").

## Der Mechanismus: verzögertes Rendern

Die naheliegende Lösung — beide Ablagen bei jeder Änderung spiegeln — wurde
**verworfen**. Sie bedeutet, dass alles, was während einer Sitzung lokal
kopiert wird, im selben Moment auf dem fremden Rechner liegt; auch ein
Passwort aus dem Passwortmanager, das mit der Sitzung nichts zu tun hat.

Stattdessen derselbe Mechanismus, den RDP und die X11/Wayland-Zwischenablage
seit jeher fahren:

1. Ändert sich die Ablage auf einer Seite, geht **nur eine Ankündigung**
   hinüber — „hier liegt jetzt Text, Generation 7". Kein Inhalt, keine Grösse,
   kein Auszug.
2. Die Gegenseite trägt sich daraufhin bei ihrem Betriebssystem als
   **Eigentümer der Zwischenablage** ein, **ohne Daten zu hinterlegen**.
3. Erst wenn dort jemand tatsächlich einfügt, fragt das Betriebssystem den
   Eigentümer nach dem Inhalt — und **erst dieser Moment** löst die
   Übertragung aus.

| Handlung | Was über die Leitung geht |
|---|---|
| Lokal Strg+C (Passwort aus dem Manager) | Eine Ankündigung. **Kein Inhalt.** |
| Danach nichts weiter | Nie etwas. Sitzungsende, Ankündigung verfällt. |
| Im Player Strg+V | Der Inhalt wird geholt — einmal, für dieses Einfügen. |
| Im Player Strg+C, dann drüben Strg+V | **Gar nichts** — beides geschieht auf dem fernen Rechner. |

Der häufigste Fall kostet null Übertragung, und der gefährliche Fall kostet
ebenfalls null, solange niemand einfügt.

**Es gibt keinen Schalter und keine Richtungs-Voreinstellung zu lernen.** Der
Verzicht auf einen Bestätigungsdialog ist bewusst: ein Dialog, der bei jedem
Einfügen erscheint, wird weggeklickt, und ein weggeklickter Dialog schützt
nichts.

### Zwei Restrisiken, ausdrücklich in Kauf genommen

1. **Der Host-Nutzer kann selbst einfügen** und damit den angekündigten Inhalt
   abholen — er sitzt an seinem Rechner. Dagegen hilft nur der Schalter
   (s. „Rechte").
2. **Die Ankündigung verrät, *dass* kopiert wurde**, und den Typ. Keinen
   Inhalt.

## Architektur

### Die neue Kiste `streaming/pulse-ablage`

Gebaut wie `pulse-zeigerbild`: Format und Plattform-Kniff liegen **einmal** im
Baum. Die Begründung von damals gilt wörtlich — ein Format, das zweimal im
Baum liegt, läuft irgendwann auseinander, und zwar unbemerkt.

| Datei | Aufgabe |
|---|---|
| `format.rs` | Rahmenformat, beide Richtungen, Round-Trip-Tests |
| `stueckelung.rs` | Zerlegen und Wiederzusammensetzen unter dem Gateway-Deckel |
| `sitzung.rs` | Zustandsmaschine: angekündigt, unterwegs, Fristen |
| `beobachter.rs` | Trait „meine Ablage hat sich geändert" — wird beim **Beantworten** befragt, nicht nur beim Ankündigen (s. o.) |
| `eigentum.rs` | Trait „ich bin Eigentümer, liefere auf Abruf" + reine Anspruchs-Zustandsmaschine |
| `pruefstand.rs` | Testdoppel beider Traits, für den Rundlauftest ohne Betriebssystem |
| `plattform/{windows,macos}.rs` | die beiden Host-Umsetzungen |

**Beide Enden brauchen beide Traits.** Der Steuernde beobachtet seine Ablage
*und* besitzt sie (für das von drüben Angekündigte); der Host tut
spiegelbildlich dasselbe. Es gibt keine Sender- und keine Empfängerseite, nur
zwei gleiche Enden — deshalb genau eine Umsetzung.

### Wer die Kiste einbindet — und wer nicht

`pulse-player` (der Steuernde, auf allen drei Plattformen), `win-hq-sidecar`
und `mac-hq-sidecar` (die Hosts).

**`linux-hq-sidecar` nicht.** Linux kann heute gar nicht Host sein: `remote_input`
gibt es nur im Windows- und im macOS-Sidecar, der Linux-Sidecar kennt die
Operation nicht. Ein Linux-Rechner ist immer der Steuernde, und dort trägt der
Player.

**Die Linux-Umsetzung liegt deshalb im Player**, nicht in der Kiste
(`pulse-player/src/fernsteuerung/wayland/ablage.rs`): der Player hält für die
Zugerkennung bereits ein `wl_data_device` am Sitzplatz, und ein zweites
verdoppelte alle Ereignisse — genau die Begründung, aus der die Zugerkennung
schon heute mit einem einzigen Gerät für alle Fenster auskommt. Die Kiste
liefert dorthin nur den Trait und die **reine** Anspruchs-Zustandsmaschine
(Seriennummer-Warteschlange, s. u.), die damit ohne Compositor prüfbar bleibt.
Windows und macOS bringen ihr eigenes verstecktes Fenster mit und sind
selbsttragend.

### Was jede Plattform beisteuert

| | Beobachten | Faul liefern |
|---|---|---|
| **Windows** | `AddClipboardFormatListener` → `WM_CLIPBOARDUPDATE` | `SetClipboardData(CF_UNICODETEXT, NULL)`, dann `WM_RENDERFORMAT` beantworten |
| **macOS** | `NSPasteboard.changeCount` abfragen (200 ms) — eine Benachrichtigung gibt es dort nicht, alle pollen | `declareTypes(owner:)` + `pasteboard(_:provideDataForType:)` |
| **Linux** | `wl_data_device::selection` — **kommt heute schon an** und wird nur verworfen (`pulse-player/src/fernsteuerung/wayland/mod.rs:186`) | `wl_data_source`, auf `send(mime, fd)` in den Dateideskriptor schreiben |

Die macOS-Abfrage liest **keinen Inhalt**, nur einen Zähler.

Der Wayland-Weg ist der sauberste der drei: verzögertes Rendern ist dort kein
Kunstgriff, sondern wie das Protokoll gedacht ist.

### Transport

Neue `remote_signal`-Art `"ablage"`, gestückelt. Kein neuer Weg, keine neue
Autorisierung, kein Serverspeicher.

Verworfen wurden:

- **P2P-DataChannel** (`web/src/lib/remote/p2p.ts`) — Ende-zu-Ende und für
  Masse gebaut, aber **nicht immer verfügbar** (kein TURN in Stufe 1,
  symmetrisches NAT). Er verlangte einen Rückfallweg, also beide Wege statt
  einem — für ein paar hundert Byte. Er ist der vorgesehene Träger für
  Stufe 2.
- **Eine HTTP-Route am Gateway** — legte den Inhalt beim Server ab. Genau das,
  was dieser Entwurf vermeidet.

## Rahmenformat

Vier Rahmen, unterschieden über `t`. Eintrag `"ablage"` in `_SIGNAL_KINDS`
(`ws_remote_handlers.py`) und `RemoteSignalKind`
(`web/src/lib/ws/handlers/types`) — **die beiden Listen sind synchron zu
halten**.

| Rahmen | Felder | Bedeutung |
|---|---|---|
| `neu` | `gen`, `typ:"text"` | Meine Ablage hat sich geändert. Sonst nichts. |
| `hol` | `gen`, `id` | Bei mir wird eingefügt, gib Generation `gen` her. |
| `stueck` | `id`, `i`, `n`, `d` | Stück `i` von `n`, `d` = Base64. |
| `leer` | `id`, `grund` | `veraltet` · `zu_gross` · `weg` · `frist` |

### `gen` ist der Kern der Sicherheit gegen Verwechslung

Zwischen Ankündigung und Abruf kann sich die Ablage längst geändert haben.
Stimmt die angeforderte Generation nicht mehr mit der aktuellen überein, wird
`leer/veraltet` geantwortet. **Es wird nie ein anderer Inhalt geliefert als
der angekündigte** — fail-closed, wie überall sonst in der Fernsteuerung.

### Der Vergleich allein genügt nicht — die Änderung muss beim Antworten geprüft werden

Die Nummer wächst erst, wenn die eigene Seite die Änderung **bemerkt** hat, und
das ist ein Takt: auf macOS ein 200-ms-Poll auf `changeCount`, auf Windows eine
eingereihte `WM_CLIPBOARDUPDATE`. Der Inhalt dagegen wird im Moment der Antwort
frisch gelesen. **In dem Fenster dazwischen ist die Nummer alt und der Inhalt
neu** — und dann ginge Inhalt hinaus, den niemand angekündigt hat. Das ist kein
Randfall der Generationsregel, sondern ein Loch in der Kernzusicherung: eine
Gegenstelle darf bis zum Gateway-Deckel von 60 Nachrichten je Sekunde abfragen,
womit aus dem Rennen ein zuverlässiges Abgreif-Werkzeug wird.

Deshalb holt der Ankündiger die Änderungsmeldung **beim Beantworten selbst** ab,
bevor er liest — Prüfen und Lesen liegen an einer Stelle und in dieser
Reihenfolge, die falsche ist gar nicht erst baubar. Erkennt er dabei eine
Änderung, antwortet er `leer/veraltet` **und hängt die frische `neu` an**: ohne
sie hielte die Gegenseite für immer eine Nummer, die es nicht mehr gibt, jedes
weitere `hol` liefe wieder auf `veraltet`, und die Ablage wäre still tot.

Ein `hol` kann also **zwei** Rahmen zur Antwort haben. Gefunden hat das erst die
Schlussprüfung des ersten Bauabschnitts (2026-08-31); die Task-Prüfungen davor
sahen jede nur ihren eigenen Ausschnitt.

### Dateifest ohne Protokollbruch

Stufe 2 setzt `typ:"dateien"`, hängt an `neu` die Felder `anzahl`/`bytes` und
an `hol` einen Datei-Index. Die vier Rahmen bleiben; der Träger wechselt dann
auf den DataChannel.

## Zwei Zahlen, beide begründet

**`MAX_TEXT_BYTE = 64 KiB.`** Der Gateway deckelt eine Signalnachricht auf
8 KiB; nach Base64 und JSON-Hülle bleiben rund 5,5 KB Nutzlast je Stück —
dieselbe Rückrechnung, aus der `pulse-zeigerbild`s `MAX_LAEUFE_BYTE = 5900`
stammt. 64 KiB sind damit etwa zwölf Stücke. Darüber wird `leer/zu_gross`
geantwortet und die Oberfläche sagt es, statt still zu scheitern.

**Selbstdrosselung auf 30 Stücke/s.** Der Gateway wirft alles über 60
Signale/s **wortlos** weg, und auf demselben Zähler sitzen Zeigerform und
Vorrang. Ein ungebremster Schwall verschwände spurlos und sähe wie ein
Netzfehler aus. Das ist dieselbe Pflicht, die die Wire-Spec dem Steuernden für
Eingaben schon normativ auferlegt. Bei zwölf Stücken heisst das: rund 0,4 s
vom Einfügen bis zum Inhalt.

## Die Gefahr: der blockierende Rückruf

Verzögertes Rendern heisst auf Windows und macOS, dass das Betriebssystem
**synchron** anruft, während das einfügende Programm wartet.
`WM_RENDERFORMAT` muss mit `SetClipboardData` beantwortet werden, bevor der
Rückruf zurückkehrt; `pasteboard(_:provideDataForType:)` genauso. In dieser
Zeit warten wir auf einen Netz-Umlauf — rund 0,4 s.

**Der Rückruf darf deshalb auf keinem Faden liegen, der etwas anderes trägt:**

| Faden | Was stillstünde |
|---|---|
| winit-Ereignisschleife (Player) | Bild **und** Eingabeerfassung — der Player friert bei jedem Einfügen ein |
| Sidecar-Injektionsfaden | die Fernsteuerung selbst |
| Hook-Faden der Vorrang-Wache | Windows hängt einen beschäftigten Hook-Faden **stillschweigend ab** (bereits als Falle dokumentiert) |

Also **ein eigener Faden mit einem nur für Nachrichten sichtbaren Fenster**
(`HWND_MESSAGE` auf Windows, eine eigene Run-Loop auf macOS).

**Auf Linux entfällt das Problem nur beim LIEFERN.** Dort legt `send` den
Dateideskriptor beiseite und geschrieben wird auf einem eigenen Faden — niemand
blockiert. **Das Lesen einer fremden Auswahl blockiert sehr wohl:** es ist
zwingend ein Rundlauf durch einen fremden Klienten (Deskriptor anfordern, warten,
bis der Eigentümer schreibt), und wenn der gerade hängt, wartet man die volle
Frist. Es gehört deshalb genauso von der Ereignisschleife weg wie der Rückruf auf
den anderen beiden Plattformen — beim Player trägt diese Schleife **Bild und
Eingabeerfassung**, ein halbe-Sekunde-Aussetzer friert also die Fernsteuerung ein.

*(Die frühere Fassung sagte pauschal „auf Linux entfällt das Problem". Sie stimmte
für die eine Richtung und wurde beim Bau von Plan 1b-1 für die andere widerlegt —
gefunden von der Task-Prüfung, nachgesehen am Aufrufpfad, nicht gefolgert.)*

## Fristen

`ABRUF_FRIST = 2 s` vom `hol` bis zum letzten Stück. Läuft sie ab, wird eine
**leere Zeichenkette** geliefert und der Rückruf freigegeben. Ein Einfügen,
das nichts einfügt, versteht jeder; ein hängendes Programm nicht.

Die Zahl steht in einer Beziehung, die ein Test festhalten muss:

```
ABRUF_FRIST (2 s)  <  REMOTE_DISCONNECT_GRACE_S (10 s)
```

Reisst der Socket mitten im Abruf ab, hält die Gnadenfrist die **Sitzung**
offen — der **Abruf** darf trotzdem nicht darauf warten, sonst steht das
einfügende Programm zehn Sekunden. Die Frist läuft ab, es wird leer geliefert,
die Sitzung lebt weiter. Dieselbe Bauart wie `CLIENT_GRACE_MS` gegen die
Server-Frist, die ebenfalls ein Test festhält.

**Die Frist darf nicht an der Sorgfalt ihres Aufrufers hängen.** Ein Takt, der
sie prüft, ist Verbraucher-Disziplin — und aufgehört zu takten wird genau dann,
wenn niemand mehr auf ein Einfügen wartet. Ginge dabei eine Antwort verloren,
bliebe der Abruf für den Rest der Sitzung stehen und jeder weitere Versuch
liefe stumm ins Leere: die Ablage wäre tot, ohne Log und ohne Fehler. Der
Abruf-Aufbau räumt einen abgelaufenen Vorgänger deshalb **selbst**.

## Wer besitzt die Ablage bei mehreren Plätzen

Auf dem Host läuft **ein Sidecar-Prozess je Platz** — bei drei Bildschirmen
drei Prozesse. Die Zwischenablage ist maschinenweit. Beanspruchten alle drei
sie, überschrieben sie sich gegenseitig.

**Genau ein Prozess je Maschine ist Träger**, bestimmt wird er dort, wo die
Plätze ohnehin zusammenlaufen: im Renderer des Hosts. Das ist wörtlich
dieselbe Auflösung wie beim Vorrang — auch dort war der erste Bau je Prozess
gedacht, und der Steuernde konnte auf einen ungewachten Platz ausweichen.

Beim Steuernden stellt sich die Frage nicht: der Player ist **ein** Prozess
mit mehreren Fenstern.

## Wayland braucht eine Seriennummer, die er nicht immer hat

`set_selection` verlangt eine Seriennummer aus einem frischen
Eingabeereignis. Ein Klient **ohne Fokus kann die Auswahl nicht setzen** — der
Compositor verwirft es, und zwar **still**.

Genau der Fall tritt ein: du wechselst zu einem lokalen Programm, drüben wird
kopiert, die Ankündigung kommt an — und der Player hat keinen Fokus. Deshalb
wird der Eigentumsanspruch **eingereiht, bis eine gültige Seriennummer
vorliegt**, und beim nächsten Fenster-Ereignis eingelöst. Die Lehre steht
schon in `wayland/mod.rs`: wer eine Seriennummer braucht, muss sie im
Fenster-Ereignis selbst holen, sonst nimmt er die des vorigen Drucks — und
der Compositor verwirft sie wortlos.

## Eigentum zerstört den Vorbestand

Sobald wir die lokale Ablage beanspruchen, ist **weg, was vorher drin war**.
Kündigt der ferne Rechner etwas an, das nie eingefügt wird, ist der eigene
kopierte Pfad verloren — still, durch fremde Aktivität.

Deshalb gehört in Stufe 1: **beim ersten Anspruch den eigenen Inhalt lesen und
merken; bei Sitzungsende zurückschreiben**, sofern wir dann noch Eigentümer
sind (hat inzwischen jemand anders kopiert, bleibt dessen Inhalt stehen). Das
Lesen ist rein lokal — es verlässt den Rechner nie.

**Beide Einschränkungen in diesem Satz sind tragend, und beide wurden beim
ersten Bau übersehen** (gefunden in der Schlussprüfung 2026-08-31):

- **„beim ersten"** — wer bei *jedem* Anspruch merkt, setzt den Merkposten beim
  zweiten auf leer, weil die Ablage nach dem ersten schon leer ist. Zwei
  Ankündigungen hintereinander sind der Normalfall, nicht der Randfall; der
  Mechanismus vernichtete dann genau das, was er retten soll. Dazu passend
  ignoriert der Empfänger eine Ankündigung mit **unveränderter** Generation —
  sie ist nur eine Auffrischung und braucht keinen zweiten Anspruch (auf
  Wayland spart das ein wirkungsloses zweites `set_selection`).
- **„sofern wir noch Eigentümer sind"** — hat der Nutzer inzwischen selbst
  kopiert, gehört die Ablage ihm. Sie beim Sitzungsende mit einem Merkposten
  von vorhin zu überschreiben wäre derselbe stille Verlust, gegen den der
  Merkposten gebaut ist.

## Rechte

**Kein neuer Permission-Bit.** `REMOTE_CONTROL` (Bit 37) genügt: wer es hält,
darf auf dem fremden Rechner tippen und kann sich den Ablage-Inhalt heute
schon holen, indem er einen Editor öffnet, einfügt und den Bildschirm liest.
Der Kanal fügt Bequemlichkeit hinzu, keine Befugnis. Ein eigenes Bit
behauptete eine Grenze, die es nicht gibt.

Zwei Ergänzungen:

- **Ein Schalter im Fern-Menü des Players** — das ist das egui-Overlay des
  Players, nicht der Web-Renderer. Er gilt **je Player-Fenster**, Vorgabe an, und
  **überlebt das Ende einer Fernsteuerung**. Er schaltet auf **dieser** Maschine
  beides ab — ankündigen und ausliefern —, und Ausschalten **gibt einen laufenden
  Anspruch frei und schreibt den Vorbestand zurück**, statt nur künftige
  Ansprüche zu unterlassen: sonst bliebe die Ablage des Nutzers leer, obwohl er
  das Teilen gerade abgeschaltet hat, und ausgerechnet der Schalter, der
  Vertrauen herstellen soll, hinterliesse Schaden.

  *(Hier stand „je Sitzung, Vorgabe an" — mehrdeutig, und beim Bau prompt anders
  gelesen. Entschieden wurde fail-safe: setzte der Schalter sich beim Sitzungsende
  zurück, würde eine ausdrückliche Datenschutz-Entscheidung des Nutzers **still**
  widerrufen, und er merkte es nur beim Öffnen des Menüs. Bleibt er stehen, teilt
  er weniger als erwartet — sichtbar, und der Schaden ist ein ausbleibendes
  Einfügen.)*
- **Eine Zeile im bestehenden Zustimmungsdialog**
  (`RemoteConsentDialog.svelte`): eine Zustimmung, die nicht benennt, was sie
  umfasst, ist keine.

## Zusammenspiel mit dem Bestand

| Bestand | Entscheidung |
|---|---|
| **Vorrang des Hosts** | **Gilt nicht für die Ablage.** Ein Abruf ist keine Injektion. Der Vorrang ist genau dann aktiv, wenn der Host-Nutzer selbst tippt — würde er greifen, schlüge ausgerechnet **dessen eigenes** Einfügen fehl. |
| **Gnadenfrist** | Der Abruf wartet nicht darauf (s. „Fristen"). |
| **`remote_reclaim`** | Nach erfolgreichem Reclaim schicken **beide** Seiten ein frisches `neu`. Sonst hält die Gegenseite ein Versprechen auf eine Generation, die hier niemand mehr kennt, und jedes Einfügen antwortet `veraltet`. Derselbe Nachzieh-Gedanke wie `beiWiederhergestellt` → Hello + `nachziehBuendel()`. |
| **`remote_end`** | Der eine Trichter, durch den jede Sitzung verschwindet — dort Eigentum abgeben und Vorbestand zurückschreiben. |
| **Standplatz-Geräte** | Läuft mit; die Dauerfreigabe deckt es. Die Trägerwahl gilt dort genauso. |
| **Mehrere Host-Bildschirme** | Ein Träger je Maschine, gewählt im Renderer. |

**Der Renderer parst den Ablage-Rahmen nicht.** Er reicht ihn durch und routet
nur nach Sitzung und Träger-Platz — dieselbe Linie wie „der Gateway parst
Frames nicht". Damit existiert das Format an **genau einer** Stelle im Baum,
und der Sprachgrenzen-Fehler, der beim Zeigerbild durch beide Testnetze
rutschte, kann hier nicht entstehen. Ein Prüfstein wie
`streaming/zeigerbild-formen.json` ist deshalb **nicht** nötig.

## Abhängigkeiten

Windows und Linux brauchen **nichts Neues**: `windows` 0.62 liegt in
`win-hq-sidecar` und `pulse-player`, `wayland-client` 0.31 im Player.

Die Kiste selbst nennt **zwei** Abhängigkeiten: `pulse-fernsteuerung` (Pfad,
Schwesterkiste im selben Baum — von dort kommt das handgeschriebene Base64) und
`serde_json`. Letzteres ist eine **direkte** crates.io-Abhängigkeit;
`pulse-fernsteuerung` re-exportiert es nicht, die Deklaration ist also nötig.
Sie beschwert trotzdem keinen Bauweg, weil alle Verbraucher `serde_json`
ohnehin schon führen — dieselbe Nachmessung, mit der es in
`pulse-fernsteuerung/Cargo.toml` aufgenommen wurde. **Die Grenze bleibt hart:**
jede weitere Abhängigkeit braucht ihre eigene Nachmessung und eine eigene
Entscheidung.

(Die frühere Fassung dieses Absatzes behauptete „keine Fremdquelle" und zählte
eine Abhängigkeit, wo zwei stehen — nachgesehen und berichtigt am 2026-08-31.)

**Eine offene Freigabe:** der Player hat heute **keine** macOS-Abhängigkeit.
`NSPasteboard` dort verlangt `objc2` + `objc2-app-kit` (die `objc2`-Familie
liegt schon im mac-Sidecar, aber nicht im Player). Ohne sie bliebe der
Steuernde auf dem Mac aussen vor. Projektregel: keine neuen Abhängigkeiten
ohne Rückfrage — vor der Umsetzung zu klären.

## Prüfung

| Ebene | Was |
|---|---|
| `pulse-ablage` | Round-Trip über alle vier Rahmen; Generationswechsel → `veraltet`; Überlänge → `zu_gross`; Fristablauf → leer statt Hänger |
| Beziehungstest | `ABRUF_FRIST < REMOTE_DISCONNECT_GRACE_S`, mit Spiegelkonstante und Gegenprobe — wie `CLIENT_GRACE_MS` heute |
| Gateway | `"ablage"` in `_SIGNAL_KINDS`; Deckel- und Fremd-Peer-Ablehnung |
| `streaming/zwillinge` | Der Prüfstein zwingt die neue Kiste in die Pfad-Filter von `win-build.yml`/`mac-build.yml`/`flatpak.yml` **und** ins Flatpak-Manifest — er hat genau diesen Fehler bei `pulse-bildmarke` schon gefangen |
| Gate | **Kein Eingriff nötig** — `gate-rust.sh` fährt jede geänderte `streaming/pulse-*`-Kiste über eine Schleife, `pulse-ablage` fällt automatisch hinein. Nachgesehen 2026-08-31, nicht angenommen. |
| **Windows-Auslieferung** | `streaming/pulse-*` steht rekursiv in der Bump-Liste → **Versions-Bump ist Pflicht**, sonst erreicht die Änderung keinen Bestandsclient |
| Von Hand | Echtes Kopieren über zwei Maschinen, je Paarung. Nicht automatisierbar — im Testaufbau gibt es weder Sitzung noch Ablage. |

## Nicht-Ziele

- **Keine Dateien, keine Bilder, keine Formatierung.** Dateien sind Stufe 2:
  Strg+C im Dateimanager legt nur **Pfade** in die Ablage (`CF_HDROP`,
  `NSPasteboardTypeFileURL`, `text/uri-list`), die auf dem anderen Rechner
  bedeutungslos sind — es müssen echte Bytes hinüber und dort als Datei
  erscheinen. Der Mechanismus (Staging in einen Temp-Ordner mit eigenem
  Fortschrittsfenster gegen echte Dateiversprechen per `IStream` /
  `NSFilePromiseProvider`) ist **offen** und gehört in Stufe 2s eigenen
  Entwurf. Auf Linux gibt es kein Versprechen — dort ist Staging alternativlos.
- **Kein Ablage-Verlauf**, kein Manager, keine Mehrfachablage.
- **Kein Ende-zu-Ende.** Bei einem Abruf sieht der Gateway den Inhalt — TLS
  auf dem Draht, aber nicht Ende-zu-Ende. Das ist **kein neuer Verlust**: die
  Fernsteuerung schickt jeden Tastendruck als Scancode über denselben Weg, ein
  drüben getipptes Passwort ist heute schon dabei.
- **Kein Schutz gegen den Host-Nutzer selbst.** Er sitzt an seinem Rechner und
  kann während der Sitzung einfügen. Dagegen hilft nur der Schalter.
- **Kein Changelog-Eintrag in Stufe 1** — wie die Fernsteuerung selbst hängt
  das Merkmal an `REMOTE_CONTROL`, das nicht in `DEFAULT_EVERYONE_PERMISSIONS`
  steht; ohne Admin-Zuteilung sieht es kein Nutzer.
