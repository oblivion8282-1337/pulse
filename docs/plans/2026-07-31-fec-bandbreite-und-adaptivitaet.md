# FEC-Bandbreite: was die 20 Prozent kosten und was sie ersetzen könnte

**Stand 2026-07-31.** Ausgangsfrage des Nutzers: Gibt es zur heutigen
FlexFEC-Reparatur eine Alternative, die mit **weniger Bandbreite** auskommt?

Dieses Dokument ist eine **Analyse, keine Messung**. Nichts darin ist am
laufenden System nachgewiesen; es ist aus dem Quelltext dieses Branches, den
vorhandenen Messakten und externer Literatur zusammengetragen. Die Einordnung
folgt den Klassen aus `streaming/pulse-player/WISSENSSTAND.md`:

| Klasse | Bedeutung |
|---|---|
| **GEMESSEN** | in einer Akte unter `streaming/testbench/profiles/` belegt |
| **GELESEN** | aus Quelltext abgelesen, mit Belegstelle |
| **EXTERN** | aus fremder Veröffentlichung, nicht an unserem System geprüft |
| **VERMUTET** | Schlussfolgerung von mir. **Nicht als Entscheidungsgrundlage benutzen.** |

---

## 1. Der Befund

**GELESEN.** Der Aufschlag ist **fest 20 Prozent und unabhängig davon, ob
überhaupt etwas verloren geht.** `pulseFlexFECConfig()` liest
`PULSE_FLEXFEC_MEDIA` (Vorgabe 10) und `PULSE_FLEXFEC_FEC` (Vorgabe 2) aus der
Prozess-Umgebung — `infra/mediamtx-fork/patches/0003-flexfec-on-whep.patch:102-113`.
Aufgerufen wird sie genau einmal in `registerInterceptors(...)` (ebenda:133),
und das hängt an `PeerConnection.Start()` (ebenda:149-154). Rate und Ein/Aus
stehen damit **pro Sitzung beim Verbindungsaufbau fest** und sind danach
unveränderlich.

**GEMESSEN** (`nack-2026-07-29-echte-leitung.json`): Die Teststrecke verliert
bei passender Bitrate **nichts** — zwei Läufe, 11591 und 15641 Pakete, null
Verlust. Auf einer solchen Leitung sind die 20 Prozent vollständig umsonst
bezahlt. Das ist der eigentliche Konstruktionsfehler, nicht die Höhe des Werts.

---

## 2. Die Alternativen, nach Bandbreiten-Effizienz

### 2.1 Parität nur bei Verlust (adaptiv) — der größte Hebel

Kosten auf gesunder Leitung: **null**. Preis ist Reaktionsverzögerung — bis der
Server die Verlustrate kennt, vergeht ein RTCP-Zyklus, der Beginn einer Störung
läuft ungeschützt.

**VERMUTET:** Das ist verkraftbar, weil NACK genau dieses Anfangsfenster
bedient; die beiden Verfahren ergänzen sich zeitlich. Nicht geprüft.

**EXTERN:** Chrome/libwebrtc leitet die FEC-Rate aus der geschätzten
Verlustrate ab und schaltet unterhalb etwa 1 Prozent ganz ab. Pions eigener
Blog schreibt, FEC gehöre dynamisch geregelt und sei kein Setz-und-vergiss-
Häkchen — wir benutzen genau deren Interceptor in eben dieser Form.

### 2.2 Reed-Solomon statt XOR — mehr Schutz pro Byte

**EXTERN.** XOR repariert genau **ein** Loch je Gruppe. Reed-Solomon mit r
Paritätspaketen repariert **beliebige r** Löcher unter k+r Paketen (MDS, also
beweisbar optimal). Bei gleichem Overhead strikt mehr Reparatur, und
insbesondere unempfindlich gegen das *Muster* des Verlusts.

Das trifft genau unseren gemessenen Fehlschlag: **GEMESSEN**
(`fec-2026-07-29-*`, Commit `6b05bd6b`) — Bündel von 2,5 Paketen gegen
Verschränkungsabstand 2 heißt zwei Löcher in derselben Gruppe, und XOR löst nur
eine Unbekannte. Ergebnis: Sekunden ohne Bild 3,0 → 3,5, die Parität bringt
nichts und ist minimal schlechter.

**Korrektur an der Begründung im Patch.** Der Patch-Kopf begründet die 20
Prozent mit „matching Sunshine" (`0003-...patch:44-47`). **EXTERN:**
Sunshine/Moonlight fahren aber **Reed-Solomon** (nanors), kein XOR. Die 20
Prozent sind damit von einem Verfahren abgeschrieben, das pro Byte deutlich
mehr kauft. **VERMUTET:** Mit RS wären ~10 Prozent plausibel und unter
Bündelverlust immer noch besser als heute 20 Prozent XOR. Ungeprüft.

Aufwand: weder pion noch webrtc-rs bringen RS mit — beide Seiten. Nicht bei
null anfangen: `fec-rs` (Rust, SIMD, GF(2^8) Moonlight-kompatibel) für den
Empfänger, nanors für die Go-Seite.

### 2.3 Ungleicher Schutz — nur schützen, was wehtut

**GEMESSEN** (Commit `abb654d2`): Bei 10 Prozent Verlust ist die Sitzung ohne
Parität praktisch tot (Bildrate Median 0, zwanzig von dreißig Sekunden ohne
Bild), mit Parität läuft sie mit 57-58 fps. Die benannte Ursache: ein Keyframe
sind 25-35 Pakete, bei 10 Prozent überlebt so ein Bündel praktisch nie
vollständig, der Player findet keinen Einstiegspunkt.

**VERMUTET:** Wenn nur die Keyframe-Pakete Parität bekommen, kostet das einen
Bruchteil eines pauschalen Aufschlags bei fast dem gleichen Nutzen.
**EXTERN:** Chrome hat 2025 die verwandte Variante ausgeliefert — FlexFEC nur
auf der SVC-Basisschicht, rund 35 Prozent weniger Overhead.

Aufwand: pions Abdeckung ist rein mechanisch (`X mod N`) und weiß nicht,
welches Paket wichtig ist. Also Eingriff im Fork.

### 2.4 Gar keine Redundanz — LTR statt Vollbild

Null Overhead. Statt „Lücke → PLI → volles Keyframe" fordert der Empfänger ein
P-Bild an, das auf die letzte nachweislich heile Langzeit-Referenz zeigt.

**GEMESSEN** (Commit `22734a98`): Vollbilder kosten die vierzigfache Bitrate.
**GEMESSEN** (`decoder-2026-07-29-intra-refresh.json`): Intra-Refresh heilt
sich nach Verlust nicht — LTR griffe genau dort.
**EXTERN:** Meta berichtet, LTR-P sei 40-50 Prozent kleiner als ein Keyframe
bei vergleichbarer Qualität, knapp 20 Prozent weniger Keyframes unter Verlust
ohne mehr Ruckler.

**GELESEN** (`WISSENSSTAND.md` §4): Blockiert — NVENC hat `enableLTR`, FFmpeg
reicht es für `av1_nvenc` nicht durch.

### 2.5 Der billigste Hebel ist längst gezogen: NACK

NACK kostet Bandbreite **proportional zum tatsächlichen Verlust**, nicht
pauschal. **GEMESSEN** (Commit `c54c01c4`): Über die echte Leitung bei 4000
kbps geht der FEC-Gewinn unter, weil von ~1400 gestörten Paketen nur ~330
endgültig fehlen und den Rest NACK holt. FEC verdient sich sein Geld nur, wo
NACK strukturell nicht kann — Umlaufzeit über der Puffergeduld, oder wenn die
Nachlieferung selbst verloren geht.

---

## 3. Wie teuer wäre 2.1 wirklich

### 3.1 Die Rückmeldung liegt bereits entpackt herum

**GELESEN.** Der Player sendet ohnehin RTCP Receiver Reports —
`streaming/pulse-player/src/whep.rs:254` (`configure_rtcp_reports`), registriert
in `connect()` (`whep.rs:278-281`).

Serverseitig kommen sie an **und werden bereits ausgepackt**:
`infra/mediamtx-fork/patches/0002-forward-viewer-keyframe-requests.patch:159-181`
liest den RTCP-Rückkanal des Lesers und ruft `rtcp.Unmarshal(...)` — konsumiert
daraus aber ausschließlich `PictureLossIndication` und `FullIntraRequest`
(ebenda:176-178). Der `ReceiverReport` mit `fraction lost` liegt in derselben
Schleife im selben Slice und wird fallengelassen.

**Das ist der Andockpunkt.** Kein neuer Rückkanal, kein DataChannel, keine
SDP-Änderung — eine zusätzliche Verzweigung an einer Stelle, die schon
gepatcht ist.

**GELESEN, zur Vollständigkeit:** Ein anderer Rückkanal existiert nicht. Im
Player kein DataChannel (kein Treffer über `src/`), einziger `write_rtcp`-Aufruf
ist das PLI (`whep.rs:152`), HTTP nur WHEP selbst (`whep.rs:439-440`, `:162`).
`OnCC`/Bandwidth-Estimation gibt es im Fork nicht.

### 3.2 Der Kniff, der den pion-Fork erspart

Die Rate mitten in der Sitzung zu **ändern** bräuchte einen Setter am
Interceptor; pion nimmt die Werte als Bau-Optionen entgegen
(`ConfigureFlexFEC03(... flexfec.NumMediaPackets(medien), flexfec.NumFECPackets(paritaet))`,
`0003-...patch:133-140`). Ob sie nachträglich änderbar sind, ist **nicht im Repo
belegbar** (pion-Quelle nicht eingecheckt); nach der Bauweise wäre ein Fork des
Interceptors nötig.

**VERMUTET — der Vorschlag dieses Dokuments:** Für die Bandbreite ist es
gleichgültig, ob die Rate sinkt oder die Paritätspakete **gar nicht erst
hinausgehen**. Ein Filter, der den Paritätsstrom unterdrückt, solange
`fraction lost` unter einer Schwelle liegt, ergibt dieselbe Ersparnis (20 → 0
Prozent) und lässt pion unangetastet.

**GELESEN, spricht dafür:** Empfängerseitig ist das gefahrlos.
`streaming/pulse-player/src/fec/empfaenger.rs` schlüsselt über die
Basis-Sequenznummer aus dem Paritätskopf; es gibt keine Lückenprüfung auf dem
Paritätsstrom. Der Player sieht schlicht keine Parität und repariert nicht.

**Die Falle dabei — VERMUTET, aber ernst zu nehmen:** Der Patch registriert
FlexFEC bewusst **vor** TWCC (`0003-...patch:124-128`), damit TWCC die
Paritätspakete nicht anfasst. Ein Filter, der *nach* der TWCC-Markierung
verwirft, ließe die verworfenen Pakete beim Zuschauer als Verlust erscheinen —
eine Regelschleife, die sich von ihrer eigenen Wirkung füttert. Der Filter muss
vor die Markierung. Heute vermutlich folgenlos (kein `OnCC` im Fork), aber
genau die Sorte stille Falle, die später niemand mehr findet.

### 3.3 Drei Stufen

| Stufe | Was | Aufwand |
|---|---|---|
| **1** | `fraction lost` aus den vorhandenen RRs lesen, Paritätsstrom unter Schwelle unterdrücken | klein — eine Datei im Fork, kein pion-Eingriff |
| **2** | Rate pro Sitzung statt aus `os.Getenv` | mittel — Zustand je Sitzung statt prozessweit |
| **3** | Echte stufenlose Ratenanpassung | groß — pion-Interceptor forken (Atomics statt Bau-Optionen) |

Stufe 1 holt den Großteil. Stufe 3 lohnt erst, wenn gemessen ist, dass zwischen
„aus" und „20 Prozent" tatsächlich etwas fehlt.

**GELESEN, nebenbei nützlich:** Der Payload-Type ist auf beiden Seiten fest auf
110 verdrahtet (`0003-...patch:87`, `whep.rs:204`, `fec/mod.rs:37`). Eine
Ratenänderung erfordert deshalb keine Neuverhandlung des Codecs, nur einen neu
gebauten Interceptor. Was heute schon geht: Rate ändern und die Sitzung neu
aufbauen — die Umgebung wird bei jedem `Start()` frisch gelesen.

---

## 4. Zwei Randfunde, die vor jeder Messung weg sollten

1. **`PULSE_FLEXFEC_FEC=0` schaltet die Parität nicht ab.** Der Wert 0 fällt auf
   die Vorgabe 2 zurück (`0003-...patch:105-107`); abschalten geht nur über
   `PULSE_FLEXFEC != 1`. Wer damit einen Nullauf fahren will, misst unbemerkt
   10+2. Dieselbe Fehlerklasse, die in dieser Messreihe schon zweimal
   zugeschlagen hat (vier identische Läufe als A/B, `c54c01c4`; wirkungslose
   netem-Störung, `6b05bd6b`).

2. **Die FEC-Zähler stehen nicht in `stats`.** `repariert` / `unreparierbar` /
   `zu_spaet` existieren (`fec/empfaenger.rs:48-50`), gehen aber nur auf stderr
   (`fec/mod.rs:84-93`), während `packets_lost` sauber alle 250 ms als Ereignis
   herausgeht (`session.rs:484`, `:516-526`). Für ein A/B einer Regelung müssen
   beide in derselben Akte stehen. Das ist der kleinste sinnvolle erste Schritt.

Ebenfalls anzumerken: Der Player kennt seine Verlustrate nur als **kumulativen
Zähler** (`jitter.rs:80`), nicht als Rate. Eine `fraction lost`-artige Größe
müsste der Konsument aus den 250-ms-Deltas bilden.

---

## 5. Voraussetzung, die alles blockiert

**GELESEN.** `streaming/pulse-player/Cargo.toml:106-107`:

```
[patch.crates-io]
webrtc = { path = "../../../webrtc-rs-pulse/webrtc" }
```

Dieser Zweig (v0.17.2 + 24 Zeilen, zwei lesende Methoden für nicht angemeldete
Ströme) liegt laut `docs/plans/2026-07-29-amd-linux-uebergabe.md` **nur auf der
NVIDIA-Maschine**. Ein fehlender `[patch.crates-io]`-Pfad ist kein Teilausfall:
cargo bricht schon beim Auflösen ab, nachgestellt und bestätigt —

```
error: failed to load source for dependency `webrtc`
Caused by: failed to read .../webrtc-rs-pulse/webrtc/Cargo.toml
```

Also kein Player, kein FEC-Empfang, kein `cargo test` für `flexfec03.rs` —
**nicht nur der Paritätspfad, der ganze Player.** Solange 24 Zeilen auf genau
einem Rechner liegen, ist der Player ein Ein-Maschinen-Programm; das trifft auch
die AMD-Maschine und jedes CI.

**Erster Schritt, unabhängig von allem anderen:** den Zweig ins Repo holen — als
Patch-Datei unter `streaming/pulse-player/patches/` analog zu
`infra/mediamtx-fork/patches/`, oder vendored. Der Diff liegt auf der
NVIDIA-Maschine: `git -C ~/Dokumente/webrtc-rs-pulse format-patch v0.17.2`.

---

## 6. Wo was überhaupt messbar ist

Geprüft auf dem Mac (Apple M2, Darwin 24.6.0) am 2026-07-31:

| Voraussetzung | Mac | Anmerkung |
|---|---|---|
| Player bauen | **nein** | webrtc-rs-Zweig fehlt, s. §5 |
| Hardware-Decode | **nein** | `decode.rs:109` kennt nur cuvid/qsv/vaapi; **VideoToolbox steht nicht in der Liste** |
| Verlust künstlich erzeugen | **nein** | `netz-harness.py` ist auf `sudo tc netem` verdrahtet (`:139-148`) und liest die tc-Zähler als Lebendkontrolle (`:154-168`). macOS hat nur `dnctl`/`pfctl`, kein Gegenstück, und kein Äquivalent zu `loss gemodel` für Bündel |
| MediaMTX-Fork bauen und prüfen | **ja** | Go, Docker läuft; `go vet` + Pakettests |
| Go-seitige Randfunde beheben | **ja** | §4 Punkt 1 |

**Und ein Mangel, der die Linux-Maschine genauso trifft:** `WISSENSSTAND.md` §7
Punkt 1 — es fehlt eine Teststrecke, die **gleichzeitig** verliert und
Umlaufzeit hat (lokal Verlust ohne RTT, fern RTT ohne Verlust). Für eine
verlustgeregelte Parität ist genau das die entscheidende Bedingung. Ohne diese
Strecke ist Stufe 1 baubar, aber nicht bewertbar.

Sinnvolle Arbeitsteilung: Serverseite auf einem beliebigen Rechner bauen und
prüfen, gemessen wird auf der Linux/NVIDIA-Maschine.

---

## 7. Empfohlene Reihenfolge

1. **webrtc-rs-Zweig ins Repo** (§5). Blockiert alles andere und jede zweite
   Maschine.
2. **Randfunde beheben** (§4). Ohne die Zähler in der Statistik lässt sich der
   Nutzen einer Regelung nicht belegen, und `PULSE_FLEXFEC_FEC=0` ist eine
   gestellte Falle für den nächsten Nullauf.
3. **Teststrecke mit Verlust *und* Umlaufzeit** (§6). Ohne sie bleibt jede
   Bewertung Papier.
4. **Stufe 1 der Adaptivität** (§3.3), dann A/B gegen heute.
5. Erst danach entscheiden, ob Reed-Solomon (§2.2) oder ungleicher Schutz
   (§2.3) dazukommt.

Unabhängig davon bleibt **20+4 statt 10+2** ein Gratis-Gewinn bei gleichem
Overhead (Verschränkungsabstand 4 statt 2, gemessen in `c54c01c4`) — aber es ist
ausdrücklich **keine** Bandbreiten-Ersparnis und beantwortet die Ausgangsfrage
nicht.

---

## Quellen (extern)

- Pion, *FEC with Pion* — https://pion.ly/blog/fec-with-pion/
- Sunshine, Network Streaming Architecture — https://deepwiki.com/LizardByte/Sunshine/4-core-streaming-architecture
- `fec-rs`, Reed-Solomon in Rust, Moonlight-kompatibel — https://github.com/hgaiser/fec-rs
- GetStream, *Media Resilience in WebRTC* — https://getstream.io/resources/projects/webrtc/advanced/media-resilience/
- Holmer/Shemer/Paniconi (Google), *Handling Packet Loss in WebRTC* — https://research.google.com/pubs/archive/41611.pdf
- Meta, *Enhancing Video Network Resiliency With LTR and RS Code* — https://atscaleconference.com/enhancing-video-network-resiliency-with-ltr-and-rs-code/
