# Dependency Descriptor: eine echte Bildnummer statt einer gedeuteten Uhr

Entwurf, 2026-08-21. Ersetzt `streaming/pulse-player/src/bildluecke.rs`
(ausgeliefert am selben Tag mit 0.1.69) und die beiden anderen Verlust-Vermutungen
im Player.

Betrifft: `streaming/win-hq-sidecar/src/whip/**`,
`streaming/linux-hq-sidecar/src/whip/**`, `streaming/pulse-player/src/**`,
`infra/mediamtx-fork/patches/`.

---

## 1. Ausgangslage: der Fehler, der die Lücke zeigt

Am 2026-08-21 um 10:49 hat eine Linux-Maschine die Fassung 0.1.69 bekommen. Vier
Minuten später, in der ersten Sitzung danach, forderte der Player rund **ein
halbes Vollbild je Sekunde** an, obwohl der Vollbild-Abstand auf 60 Sekunden
steht. In den Stunden davor lag der Abstand über mehrere Sitzungen hinweg bei
60,0 Sekunden.

Gemessen mit `PULSE_PLAYER_ERHOLUNG_LOG=1` an der laufenden Leitung
(Windows/AMD sendet AV1, Linux/NVIDIA schaut über `pulse-player`):

```
10:33:11.101  Bildluecke (#5) — 1 Bild(er) ausgefallen, Vollbild angefordert
10:33:11.175  Vollbild #3 empfangen, Abstand 6463 ms      <- 74 ms spaeter
10:33:12.615  Bildluecke (#6) — 1 Bild(er) ausgefallen, Vollbild angefordert
10:33:12.689  Vollbild #4 empfangen, Abstand 1514 ms      <- 74 ms spaeter
```

Neun Meldungen in 18 Sekunden, jede rund 70 Millisekunden später von einem
Vollbild quittiert. Im selben Zeitraum: **null verworfene Einheiten, null
unreparierbare Pakete, keine Decoder-Fehler.** Es fehlte nichts.

### Warum es kein Schwellenwert-Fehler ist

Der naheliegende Verdacht war die Schwelle in `bildluecke.rs` (das Zweifache des
Medians). Der sendende Bildschirm läuft aber mit **180 Hz bei 60 fps**, also
Verhältnis `r = 3,0`. Nach der im Sender gemessenen Formel `ceil(r)/r` ist die
echte Abtast-Schwankung dort **1,0** — es kann gar keine geben. Ein Abstand vom
Doppelten ist also echt: der Sender hat einen Bildplatz ausgelassen.

Und das Bild des Zuschauers war dabei **sauber**. Wäre ein gesendetes Bild
unterwegs verlorengegangen, wäre die Referenzkette gerissen und für rund 70 ms
sichtbar zerfallen, zweimal in vier Sekunden.

Daraus folgt der Befund:

> Der Sender hat für diesen Bildplatz **nie ein Bild erzeugt** — er hat keines
> *verloren*. Ein nie erzeugtes Bild reisst nichts ab und braucht kein Vollbild.
> Der Player kann die beiden Fälle am Zeitstempel nicht unterscheiden und nimmt
> immer den schlimmeren an.

### Was das kostet

Nicht Bandbreite im Wortsinn — die Ratenregelung hält die Zielrate ein. Ein
Vollbild ist rund 110 kB gegen 4 kB eines Differenzbildes; bei 0,5
Anforderungen je Sekunde geht **grob ein Fünftel des Bit-Budgets in redundante
Vollbilder statt in Bilddetail**. Der Zuschauer bezahlt es in Schärfe, nicht in
Megabyte.

Dazu ein latenter Fehler, der noch nicht zugebissen hat: die Bildlücken-Meldung
setzt den Schadensmerker, und der verkürzt die Frist der Einfrier-Wacht auf 2,5
Sekunden. Schlägt sie an, baut sie **den Decoder neu auf**
(`decodefaden.rs:218`). Eine Fehlmeldung kurz vor einer ruhigen Bildpassage
löst damit 2,5 Sekunden später einen Decoder-Neuaufbau aus.

## 2. Warum eine Uhr keine Zählung ersetzt

Der RTP-Zeitstempel ist eine **Uhr**: er sagt, wann ein Bild aufgenommen wurde.
Der Dependency Descriptor trägt einen **Zähler**: er sagt, das wievielte Bild
es ist.

Derselbe Strom, 60 fps, 1500 Takte je Bild:

| | Zeitstempel | Bildnummer |
|---|---|---|
| alles in Ordnung | `1500 3000 4500 6000` | `41 42 43 44` |
| **Sender liess einen Platz aus** | `1500 3000 ---- 6000` | `41 42 ---- 43` |
| **ein Bild ging verloren** | `1500 3000 ---- 6000` | `41 42 (43) 44` |

Die beiden Zeitstempel-Zeilen der letzten zwei Fälle sind **identisch**. Keine
Schwelle, kein Median und kein Verfahren kann sie trennen, weil die Eingabe
dieselbe ist. Die Nummern-Zeilen sind verschieden, ohne dass etwas einzustellen
wäre.

Hinzu kommt: um aus einer Uhr eine Zählung zu machen, muss durch den Bildtakt
geteilt werden — den der Empfänger nicht kennt und deshalb schätzt (Median über
31 Bilder). Und selbst bei perfekter Schätzung beantwortet die Division die
Frage *„wie viele Bildplätze passen in diese Lücke"*, nicht *„wie viele Bilder
hat es gegeben"*.

Das erklärt auch die Vorgeschichte. Jede der bisherigen Vermutungen war
handgesetzt, aus einer Messreihe hergeleitet, und jede ist an einer Lage
gescheitert, die in dieser Messreihe nicht vorkam:

| Vermutung | Fehlschlag |
|---|---|
| Erwartungswert = kleinster Abstand | 36 153 Falschmeldungen bei null Verlust |
| Schwelle 1,5-fach | 553 Falschmeldungen in 25 s |
| Einfrier-Frist folgt dem Vollbild-Takt | wuchs auf 148 s statt 2,5 s |
| Schwelle 2,0-fach | dieser Vorfall |

Es sind keine Schlampereien, sondern Versuche, aus einer Uhr eine Zählung zu
machen. Das geht prinzipiell nicht.

## 3. Getroffene Entscheidungen

| Frage | Entscheidung | Begründung |
|---|---|---|
| Welche Sender markieren? | **Nur unsere eigenen WHIP-Sender** (Windows, Linux, künftig macOS) | Die Nummer soll die Wahrheit des Encoders tragen und auch auf einem Direktpfad ohne unseren Server gelten. MediaMTX selbst nummerieren zu lassen wäre ein Patch statt drei Baustellen, zählte aber nur, was er *gesehen* hat — ein schon auf der Publish-Strecke vollständig verlorenes Bild bliebe unbemerkt. |
| Strom ohne Marke? | **Keine Lückenerkennung** | „Marke oder nichts". `pushProtokoll()` gibt heute bedingungslos `whip` zurück (`settings.svelte.ts:422`); RTMPS wird von keiner Oberfläche mehr gewählt. Der Rückfall beträfe fast nur das Übergangsfenster. Preis: bei einem noch nicht aktualisierten Sender kann ein bei MediaMTX verworfenes Bild wieder bis zu 75 s Standbild kosten. Bewusst angenommen. |
| Wie viel vom Format? | **Zählen, in der Form der Kette** | Die kleinste zulässige Schablonen-Tabelle wird ordentlich geschrieben (das Format verlangt sie ohnehin auf Vollbildern), geurteilt wird auf der Nummernfolge. Zeitliche Schichten und verwerfbare Bilder bleiben **draussen** — wir senden keine geschichteten Ströme, es gäbe heute kein verwerfbares Bild zu erkennen. |
| Wo lebt der Leser? | **Nicht im vendorierten webrtc-Zweig** | Der steht bei 24 Zeilen Abweichung gegen v0.17.2, und das ist sein Wert. Ein eigenes Modul im Player liest die rohe Header-Erweiterung. |
| Eine Kiste oder drei Kopien? | **Zwillings-Dateien** wie `zeigerbild.rs` / `zeitbasis.rs` | Eine gemeinsame Kiste wäre sauberer, zwänge aber beide Offline-Bauwege (Flatpak-Cargo, Windows-CI) zu neuen Quellenlisten. Wortgleichheit hält ein `zwillinge.rs`-Test fest, nicht ein Kommentar. |

## 4. Architektur und Datenfluss

**Die Nummer entsteht im WHIP-Paketierer, also hinter dem Encoder.** Daran hängt
die ganze Korrektheit:

- Der Encoder verschluckt ein Bild (Ratenregelung, Last) → es entsteht kein
  Paket → keine Nummer wird vergeben → die Folge bleibt lückenlos, und das ist
  richtig: es gibt nichts zu reparieren.
- Der Bildschirm steht still, der Sidecar schiebt Wiederholbilder nach → das
  sind codierte Bilder → sie bekommen Nummern → lückenlos.
- Ein ausgelassener Bildplatz (der Fall aus §1) verbraucht keine Nummer.

Die Nummer zählt also **das, was den Encoder verlassen hat**.

```
Sidecar (Windows / Linux)
  Encoder gibt ein Bild aus
  → whip/av1.rs paketiert, haengt an JEDES Paket 3 Byte
    (Bildanfang / Bildende / Schablone / laufende Nummer);
    auf Vollbildern zusaetzlich einmal die Schablonen-Tabelle
  → SDP-Angebot traegt  a=extmap:<n> ...dependency-descriptor...
  → geschrieben wird NUR, wenn die Antwort die Erweiterung annimmt

MediaMTX (Patch 0006)
  liest die Marke vom eingehenden Paket
  verwirft ggf. ein beschaedigtes Bild        ← hier entsteht die Luecke
  baut die Pakete neu (unveraendert wie bisher)
  → setzt die Marke auf die neuen Pakete, mit der ID, die MIT DEM
    ZUSCHAUER ausgehandelt wurde
  → WHEP-Antwort weist das extmap aus

pulse-player
  handelt die Erweiterung aus
  liest die Nummer aus den Paketen, zaehlt sie bei VOLLSTAENDIGER Einheit
  Luecke → Vollbild anfordern.  Keine Luecke → nichts tun.
```

Drei Eigenschaften, die daraus folgen:

1. **MediaMTX entscheidet nichts.** Er rahmt drei Byte um. Verwirft er ein Bild,
   entsteht die Lücke von selbst, weil dessen Nummer nie ausgesendet wird. Der
   Patch enthält keine Logik, die falsch sein könnte.
2. **Die Nummer läuft bei 65536 um** — bei 60 fps nach gut 18 Minuten, also im
   Betrieb ständig. Umlauf-Arithmetik mit eigenem Test, wie beim Zeitstempel.
3. **Der Rückkanal bleibt unverändert.** Die Anforderung geht weiter als RTCP
   heraus und wird von Patch 0002 zum Sender durchgereicht. Der Descriptor
   ändert nur, *wann* eine rausgeht.

## 5. Das Drahtformat

Auf **jedem** Paket, drei Byte (Pflichtfelder):

```
 Bit  0      Bildanfang        (start_of_frame)
 Bit  1      Bildende          (end_of_frame)
 Bit  2-7    Schablonen-Nummer (frame_dependency_template_id)
 Bit  8-23   laufende Nummer   (frame_number, 16 Bit, Umlauf bei 65536)
```

Auf dem **ersten Paket jedes Vollbilds** zusätzlich die Schablonen-Tabelle in
unserer kleinsten zulässigen Ausprägung:

```
zwei Schablonen:  Vollbild        (beruft sich auf nichts, Kettenschritt 0)
                  Differenzbild   (beruft sich auf das vorige, Kettenschritt 1)
ein Decode-Ziel,  beide Schablonen als "erforderlich" markiert
eine Kette,       das Decode-Ziel haengt an ihr
keine Aufloesungsangaben
```

Rund zehn Byte auf Vollbildern, drei auf allen anderen — bei ~1200 Byte je
Paket unter einem Promille. Es passt in die **einbytige** Form der
RTP-Header-Erweiterung (bis 16 Byte); erst geschichtete Ströme bräuchten die
zweibytige.

**Die genaue Bitfolge wird gegen den Spezifikationstext geprüft, nicht aus dem
Gedächtnis geschrieben.** Verbindlich ist die AV1-RTP-Spezifikation der AOM;
`https://aomediacodec.github.io/av1-rtp-spec/#dependency-descriptor-rtp-header-extension`
ist zugleich der URI, der in der `extmap`-Zeile steht.

## 6. Station 1 — die Sidecars

Neue Zwillings-Datei `whip/bildmarke.rs`, gespiegelt in beide Sidecars und den
Player. Inhalt: das Format lesen und schreiben, beide Richtungen mit
Rundlauf-Test in derselben Datei (Muster `zeigerbild.rs`).

Zwei Eingriffe daneben:

- **`whip/sdp.rs`** — heute zwischen Windows und Linux **wortgleich** (392
  Zeilen). Bietet die Erweiterung im Angebot an und **liest die ID aus der
  Antwort**. Nimmt die Gegenstelle sie nicht an, wird nichts geschrieben: eine
  nicht ausgehandelte Erweiterung darf nach RFC 8285 nicht gesendet werden. Das
  ist zugleich der Rückfall gegen alte Server.
- **`whip/av1.rs`** — heute 791 Zeilen auf beiden Seiten, 8 Zeilen
  Unterschied. Führt den Zähler (ein Schritt je codiertem Bild, also je Aufruf)
  und hängt die Marke an jedes erzeugte Paket, mit korrekten Bildanfang- und
  Bildende-Bits.

macOS hat heute **kein** `whip/`-Verzeichnis und sendet über ffmpegs
WHIP-Muxer, der keine Header-Erweiterungen schreiben kann. Der dort parallel
entstehende eigene WHIP-Sender bekommt die Marke mit — sie ist der vierte Grund
für ihn, neben RTCP-Rückkanal, 60-Sekunden-Takt und AV1-Transport.

## 7. Station 2 — MediaMTX, Patch 0006

`from_stream.go` verpackt **jeden** Codec neu (`encoder.Encode(...)` für AV1,
H.264, H.265, VP9) und übernimmt vom Eingang nur den Zeitstempel. Deshalb ist
der Zeitstempel bisher „die einzige Nummerierung, die die Klebestelle
übersteht" — und deshalb genügt es nicht, die Marke nur im Sidecar zu
schreiben.

Der Patch:

1. Die Erweiterung in der Medien-Maschine registrieren und in der
   WHEP-Antwort ausweisen. Die Aushandlung ist bereits verdrahtet
   (`inbound_track.go:22` liest `params.HeaderExtensions`).
2. Nach `encoder.Encode(...)` die Marke auf die neuen Pakete setzen:
   **Nummer und Schablone unverändert** vom eingehenden Bild
   (`u.RTPPackets[0]`), **Bildanfang/Bildende neu** nach der neuen Aufteilung,
   **Schablonen-Tabelle auf das neue erste Paket** eines Vollbilds.
3. Hinter `PULSE_DEPENDENCY_DESCRIPTOR=1`, aus per Vorgabe — wie die Patches
   0002 bis 0005. Ein unkonfiguriertes Deployment verhält sich wie bisher.

Dass die Marke den Ausgang erreicht, ist geprüft: pions
`TrackLocalStaticRTP.WriteRTP` überschreibt nur SSRC und Payload-Typ, der
restliche Header geht unverändert hinaus
(`pion/webrtc@v4.2.15/track_local_static.go:195`).

**Es ist Umrahmen, nicht Kopieren.** Bildanfang und Bildende beschreiben die
Lage *dieses Pakets* im Bild; MediaMTX schneidet die Pakete neu, also
verschieben sich die Grenzen.

## 8. Station 3 — der Player

- Die Erweiterung im WHEP-Angebot aushandeln (`whep.rs`).
- Die Marke aus dem Paket-Header lesen, `bildmarke.rs` deutet sie.
- **Geurteilt wird auf vollständig zusammengesetzten Einheiten, nicht auf
  einzelnen Paketen.** Kommt von einem Bild nur ein Teil der Pakete an, hat es
  seine Nummer trotzdem schon gezeigt; auf Paketebene sähe der Player eine
  lückenlose Folge, während der Zusammensetzer das unvollständige Bild wegwirft.
  Die Nummer wird aus den Paketen gelesen, aber **erst gezählt, wenn die Einheit
  vollständig ist**. Genau daran hängt, ob der Zeugen-Auslöser von 3f311c94
  entbehrlich wird.
- **Eine Stelle urteilt über Verlust statt dreier.** (Anforderungsstellen
  insgesamt bleiben drei, siehe §9 — die beiden anderen haben mit
  Verlusterkennung nichts zu tun.)

## 9. Was wegfällt — und was bleibt

`session.rs` hat heute fünf Stellen, an denen ein Vollbild angefordert wird.

| | Stelle | heute | danach |
|---|---|---|---|
| 1 | `session.rs:632` | Jitter-Puffer gibt Pakete auf | Anforderung **weg**; `f.luecke()` **bleibt** |
| 2 | `session.rs:717` | Zeitstempel-Lücke | **weg**, mit dem Modul |
| 3 | `session.rs:749` | Zusammensetzer hat verworfen | **weg** — durch „zählen bei Vollständigkeit" abgedeckt |
| 4 | `session.rs:829` | Decoder meldet `vollbild_noetig` | bleibt |
| 5 | `session.rs:853` | noch kein Einstiegspunkt | bleibt |

Von Stelle 1 bleibt `f.luecke()` — die Ansage an den Decoder, auf einen
Einstiegspunkt zu warten. Das ist **Absturzschutz**: `libnvcuvid` stürzt ab,
wenn es ein Differenzbild ohne Referenz bekommt (2026-07-28 gemessen). Die
Anforderung selbst ist entbehrlich, weil Stelle 5 binnen 500 ms
(`EINSTIEG_REQUEST_INTERVAL`) ohnehin nachfordert und die Marke sofort.

Ausserdem:

- **`bildluecke.rs` fällt ganz** — 246 Zeilen, 7 Tests, beide handgesetzten
  Konstanten.
- **`KEYFRAME_REQUEST_INTERVAL` (200 ms) bleibt als Netz**, hört aber auf,
  tragend zu sein: Vermutungen kommen in Schüben, Gewissheiten nicht.

**Was NICHT wegfällt, entgegen einer früheren Einschätzung in der Besprechung:**
die Kopplung der Einfrier-Wacht an den Vollbild-Takt
(`einfrieren.rs::mindestdauer_zur_zeit`). Sie schützt gegen den Fehlalarm
„stehender Inhalt", und den erkennt eine lückenlose Bildnummer nicht — ein
hängender Decoder bekommt ebenfalls lückenlose Nummern von der Leitung, während
das Bild steht. Die Nummer sagt „der Strom ist gesund", nicht „das Bild bewegt
sich".

Was dort tatsächlich besser wird: der Schadensmerker wird nur noch bei echtem
Verlust gesetzt. Damit verschwindet der in §1 beschriebene latente
Decoder-Neuaufbau aus Fehlalarm.

## 10. Fehlerfälle

| Lage | Verhalten |
|---|---|
| Keine Marke (alter Sender, macOS heute, RTMPS) | Keine Lückenerkennung. Absturzschutz, Einstieg-Pfad und Einfrier-Wacht bleiben. |
| Schablonen-Nummer noch unbekannt | Der Zuschauer steigt zwischen zwei Vollbildern ein und hat die Tabelle nie gesehen: **nicht urteilen**, bis die erste Tabelle da ist. |
| Nummer läuft um (alle ~18 min bei 60 fps) | Umlauf-Arithmetik, eigener Test. |
| Sender markiert, Server ist alt | Die Erweiterung wird nicht angenommen, der Sender schreibt sie gar nicht erst → wie „keine Marke". |
| Server markiert, Player ist alt | Der alte Player handelt sie nicht aus und bekommt sie nicht → wie heute. |
| Nummern springen wild | Kein Sonderfall: eine Lücke ist eine Lücke. Die 200-ms-Bremse deckelt die Anforderungen. |

## 11. Prüfen

### Abnahmekriterium

Derselbe Aufbau, mit dem der Fehler gemessen wurde (Windows/AMD → Linux/NVIDIA,
`PULSE_PLAYER_ERHOLUNG_LOG=1`):

| | heute | Abnahme |
|---|---|---|
| Vollbild-Abstand, saubere Leitung | 0,6 bis 12 s | **wieder 60 s** |
| Anforderungen je Sekunde | ~0,5 | **null** |
| bei echtem Verlust | Anforderung sofort | Anforderung sofort, unverändert |

### Vier Prüfebenen

1. **Rundlauf im Format** — schreiben, lesen, identisch; in der Zwillings-Datei
   selbst.
2. **Wortgleichheit der drei Kopien** — `zwillinge.rs`-Test mit `include_str!`
   auf alle drei Pfade, **ausserhalb** der Zwillinge liegend, damit er sie nicht
   selbst ungleich macht.
3. **Ein Prüfstein vom Sender**, Muster `streaming/zeigerbild-formen.json`: der
   Sidecar erzeugt die Byte-Folgen (Vollbild mit Tabelle, Differenzbild,
   mehrteiliges Bild, Umlauf), sie werden festgehalten, und **alle drei
   Stationen prüfen dagegen** — Sidecar, MediaMTX-Patch, Player. Begründung:
   am 2026-08-17 rutschte ein Fehler durch beide Testnetze, weil jede Seite ihre
   Fälle aus derselben Vorstellung aufschrieb, aus der sie die Prüfung schrieb.
   Der Prüfstein muss vom Sender kommen.
4. **Chromium als Schiedsrichter.** Der Descriptor stammt aus libwebrtc; ein
   markierter Strom im Browser-Fenster mit `chrome://webrtc-internals` prüft das
   Format gegen die Referenz-Umsetzung. Die einzige Prüfung, die unser eigener
   Code nicht fälschen kann.

### Player-Einzeltests

Lückenlos → nichts. Lücke → Anforderung. Umlauf → nichts. Schablone unbekannt →
kein Urteil.

## 12. Ausrollen

**Server zuerst.** Das folgt aus dem Aufbau: der Sender schreibt nur, wenn die
Gegenstelle annimmt. Ein Server, der die Erweiterung noch nicht kennt, schaltet
sie von selbst ab.

1. **MediaMTX-Fork** → `1.19.1-pulse5` über `mediamtx-fork.yml`, auf Prod und
   den Hetzner-Dev-Stack. Trägt eine Erweiterung, die noch niemand schickt —
   folgenlos.
2. **Sidecars und Player zusammen, in einem Auslieferstand.** Player ohne
   Sidecar wäre der einzige gefährliche Zustand: er hätte seine Erkennung
   entfernt, ohne eine Marke zu bekommen.

Dazu:

- **Windows-Versionsbump ist Pflicht** (0.1.70): `streaming/pulse-player/**` und
  `win-hq-sidecar/**` ändern sich beide, electron-updater ignoriert eine gleiche
  Version stillschweigend.
- **Flatpak baut automatisch** — beide Pfade stehen in `flatpak.yml`.
- **Changelog-Eintrag**, sachlich, ohne Emojis, mit echten Umlauten. Der Nutzer
  bemerkt es an einem ruhigeren Bild bei stehendem Inhalt und an schärferem Bild
  auf begrenzter Leitung.
- **Der wartende Zweig `build/player-ffmpeg-lokal` geht mit.** `CLAUDE.md`
  bestimmt, dass er bei der nächsten echten Player-Änderung mitfährt; das hier
  ist diese Änderung. Er hat einen Konflikt gegen das Player-README, der beim
  Landen aufzulösen ist.
- **Bauen von der Linux-Maschine**: Player und Linux-Sidecar bauen lokal mit
  `FFMPEG_DIR=$PWD/ffmpeg-dist/n8.1-lgpl-shared`. Der Windows-Sidecar baut hier
  nicht — dafür `cargo check --target x86_64-pc-windows-msvc`, den echten Bau
  macht die CI.
- Feature-Zweig von frischem `main`, Landung über `bash scripts/ship.sh`. Merge
  nach `main` ist ein Prod-Deploy und braucht die Freigabe des Besitzers.

## 13. Bewusst nicht enthalten

- **Zeitliche Schichten, Decode-Ziele, verwerfbare Bilder.** Wir senden keine
  geschichteten Ströme; es gäbe heute kein verwerfbares Bild zu erkennen. Die
  Schablonen-Tabelle ist trotzdem in der richtigen Form geschrieben, damit
  Schichten später ohne Umbau hineinpassen.
- **MediaMTX nummeriert selbst.** Deckte auch RTMPS und fremde Publisher ab,
  zählte aber nur, was der Server gesehen hat.
- **Der Descriptor im vendorierten webrtc-Zweig.** Der bleibt bei 24 Zeilen
  Abweichung.
- **`zeitbasis.rs`.** Die ehrlichen Zeitstempel sind für die Bildglättung da,
  nicht für die Lückensuche. Sie bleiben unangetastet.

## 14. Offene Punkte

- **Bemerkt MediaMTX ein Bild, dessen Pakete vollständig auf der
  Publish-Strecke verlorengingen?** Wenn nicht, trägt er einfach das nächste
  Bild weiter — dessen Nummer stammt vom Sender, die Lücke klafft also trotzdem.
  Das ist der erwartete Vorteil davon, dass die Nummer beim Sender entsteht, und
  soll in der Umsetzung nachgewiesen und nicht behauptet werden.
- **Die 16-Byte-Grenze der einbytigen Erweiterungsform** reicht für die
  vorgesehene Tabelle. Wächst sie je (Schichten), ist die zweibytige Form nötig
  — das ist eine Aushandlungsfrage und betrifft alle drei Stationen.
