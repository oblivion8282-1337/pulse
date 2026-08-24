# Fernsteuerung — Neubewertung nach dem Player (2026-08-11)

Diese Datei ersetzt die drei Übergabe-Dokumente vom 2026-07-22
(`2026-07-22-remote-control-{windows-handoff,2geraete-test,input-wire-protokoll}.md`,
alle auf `feat/remote-control-windows`). Sie beschreiben eine Welt, die es nicht
mehr gibt: Zuschauen im Browser-`<video>`, ein eigener P2P-Kern, TURN als
Pflichtbaustein. Das Wire-Protokoll aus der dritten Datei gilt unverändert
weiter und wird hier nur referenziert, nicht wiederholt.

**Feature:** Fernsteuerung in Pulse (Bildschirm sehen + Maus/Tastatur steuern).
Discord/TeamViewer-Klasse, nicht Parsec-Klasse — die Abgrenzung aus
`docs/2026-07-21-remote-control-latenz-messung.md` §7.3 gilt weiter.

## Warum neu bewertet wird

Zwei Dinge haben sich seit dem 22. Juli geändert, und beide ziehen der
damaligen Architektur den Boden weg.

**1. Der native Player ist gebaut und ausgeliefert.** Das Konzept nahm an, der
Steuernde sehe den Host in einem Browser-`<video>`. HQ-Zuschauen läuft
inzwischen über `streaming/pulse-player` (eigenes Fenster, WHEP, Zero-Copy).

**2. Die Zahl, mit der der Serverweg verworfen wurde, ist falsch.** Das
Konzeptpapier schreibt: „der bestehende MediaMTX-Relay-Pfad liegt bei 300 ms+ —
fürs Zuschauen fein, für Steuern unbrauchbar". Dieser Satz trägt **keine
Messung**; er ist der einzige Grund für P2P + TURN. Am 2026-08-11 nachgemessen
(`streaming/testbench/profiles/fern-2026-08-11-serverweg-gegen-p2p.json`):

| | |
|---|---|
| Über den Labor-Server gemessen (AV1 10 bit, 60 fps) | **107–119 ms** |
| davon reine Laufzeit zum Labor und zurück | 59 ms |
| davon eigene Kette auf der Messmaschine | 44 ms |
| davon der Server selbst | rund 10 ms |
| Hochgerechnet auf howispulse.com (28 ms Umlaufzeit) | **rund 85 ms** |
| dasselbe mit der 16-ms-Kette der Juli-Maschine | **rund 55 ms** |

Zum Vergleich: P2P ist mit **45–70 ms geschätzt** (nie gemessen), und die
einzige echte Messung zwischen zwei Privatanschlüssen ergab **90 ms über TURN**
(2026-07-21 §6.2 — direkt scheiterte dort ganz).

**Der Serverweg liegt damit in derselben Klasse wie P2P im Bestfall und
schneller als P2P im gemessenen Realfall.**

Der Labor-Server wurde für diese Messung erst auf den Produktivstand gebracht
(Image über den Prod-Digest, Binary per sha256 gegen das produktive verglichen,
Konfiguration angeglichen, fehlendes `PULSE_FLEXFEC_ADAPTIV=1` nachgezogen).
Details in der Messakte.

## Die neue Architektur

Der Kern der Neubewertung in einem Satz: **Das Bild ist schon da.** Wer
fernsteuern will, schaut dem Host ohnehin gerade beim HQ-Streamen zu — im
Player, mit gemessenen ~55–85 ms. Es fehlt nur der **Rückweg für die Eingaben**.

```
Bild   (existiert, unverändert):
  Host-Sidecar --WHIP/RTMPS--> MediaMTX --WHEP--> pulse-player des Steuernden

Eingaben (neu, das ist das ganze Feature):
  pulse-player --stdio--> Electron --WS--> chat-gateway --WS--> Electron des Hosts
                                                                  --stdio--> Sidecar
                                                                  --> SendInput
```

Der Eingabe-Rückweg kostet eine halbe Umlaufzeit zum Server plus eine halbe zum
Host — zu howispulse.com also rund 29 ms. Ordnung und Zustellung garantiert die
WebSocket-Verbindung, die die App ohnehin offen hält; das ist **genau die
Zusage**, die das Wire-Protokoll vom DataChannel verlangt hat (reliable +
ordered, Begründung dort: ein Klick darf seine Positionierung nicht überholen,
ein verlorenes Key-Up wäre eine klemmende Taste).

### Was damit ersatzlos entfällt

| Weggefallen | Umfang | Warum |
|---|---|---|
| `streaming/pulse-remote-webrtc` | 228 Z. + Cargo.lock | Kein P2P mehr |
| `RemoteController`-Tee im Sidecar (M2b) | ~370 Z. + Encoder-Eingriffe | Der Stream läuft ohnehin |
| Force-IDR auf RTCP-PLI (Fix zu M2b) | 3 Encoder-Stellen | Gehört zum P2P-Track |
| TURN gesamt: `infra/coturn/`, `routes/remote_ice.py`, `iceConfig.ts` | ~180 Z. + Betrieb | Kein P2P, kein Relay |
| Controller-WebRTC + Browser-Viewer (M3, Scheiben 3–5) | ~450 Z. | Player statt `<video>` |

Damit fällt auch der **Rebase-Schmerz** weg, der den Branch blockierte: Er saß
fast vollständig im Sidecar-Tee, und `stream_controller.rs` ist auf `main`
inzwischen in ein Verzeichnis aufgeteilt.

Betrieblich entfällt die größte Position des alten Plans: coturn in mehreren
Regionen, rund **3,5 GB Relay-Verkehr je Stunde und Sitzung**.

### Was unverändert übernommen wird

| Bleibt | Wo (auf `feat/remote-control-windows`) |
|---|---|
| `remote:*`-WS-Ops + Consent-Registry (M1) | `services/chat-gateway/.../ws_remote_handlers.py`, `remote_registry.py` |
| `REMOTE_CONTROL`-Recht, Bit 37 (auf `main` noch frei) | `shared/src/dcc_shared/permissions.py` + `web/src/lib/permissions/bitfield.ts` |
| Tests dazu (~570 Z.) | `services/chat-gateway/tests/test_remote_{handlers,registry,ice}.py` |
| Input-Wire-Protokoll v1 | `docs/plans/2026-07-22-remote-control-input-wire-protokoll.md` |
| Injektion `SendInput` + Release-all (M2c) | `streaming/win-hq-sidecar/src/remote_input.rs`, 15 Unit-Tests |
| Consent-Dialog, Host-Banner, Anfrage-Knopf | `web/src/lib/remote/components/` |
| Session-Zustandsmaschine + Host-Brücke | `session.svelte.ts`, `hostBridge.ts` |
| Scancode-Tabelle aus `input.ts` | portierbar — `winit` benennt Tasten nach demselben Standard wie der Browser |
| M0-PoC als Standalone-Diagnose | `streaming/win-input-poc/` |

Die Ops tragen bisher `remote_signal` (Offer/Answer/ICE). Das entfällt; an
seine Stelle tritt ein Op, das **Eingabe-Frames** trägt. Consent-Gate,
Peer-Prüfung und Teardown bleiben, wie sie sind.

### Was neu gebaut wird

1. **Eingabe-Erfassung im Player.** `winit` liefert Tasten und Maus roh — ohne
   Pointer-Lock-Mathematik und ohne Letterbox-Rechnerei, die die Browser-Fassung
   brauchte. Die Fenster-Ereignisse laufen heute nur an egui (`overlay/mod.rs`);
   hier kommt ein zweiter Abnehmer daneben.
2. **Ein Op-Paar auf der bestehenden stdio-Verbindung** Player ↔ Electron:
   Eingabe-Frames hinaus, Steuer-Zustand herein.
3. **Ein WS-Op für Eingabe-Frames** im chat-gateway (ersetzt `remote_signal`).
4. **Durchreichen im Electron des Hosts** an den Sidecar — die Brücke dafür
   existiert (`hostBridge.ts` + `gsr.remote*`).

## Zuschnitt (entschieden)

- **Steuern nur aus der installierten App** (Electron + Player), nicht aus dem
  Browser und nicht vom Handy. Begründung ist **nicht** Latenz — der Vorteil des
  Players auf einem P2P-Pfad wurde am 2026-08-02 mit 5–10 ms von 65–90 gemessen
  (`remote-2026-08-02-chromium-jitterpuffer.json`) und ist auf dem Serverweg
  gegenstandslos. Es geht um **einen Weg statt zwei**: HQ-Zuschauen läuft über
  den Player, 10 bit und HDR kann ein `<video>` gar nicht darstellen
  (`docs/2026-07-26-chromium-10bit-messung.md`), und eine zweite, nur für die
  Fernsteuerung gepflegte Browser-Hälfte wäre Doppelarbeit.
- **Gesteuert werden kann nur Windows** (Injektion ist dort gebaut). Linux als
  Ziel: `xdg-desktop-portal RemoteDesktop`; **niri kann es nicht** (2026-07-21
  §7.2). macOS: `CGEventPost`, dazu fehlt dem Mac der Player überhaupt.
- **Steuern geht von Linux und Windows** (Player läuft dort). macOS erst, wenn
  der Player dort gebaut wird — unabhängig von diesem Feature.
- **Der Host muss HQ streamen.** Steuern ohne laufenden Stream (das alte M2d)
  bleibt zurückgestellt und ist jetzt ein Wesensmerkmal, keine Abkürzung.

### Mehrere Monitore: ist bereits da (korrigiert 2026-08-12)

**Hier stand, mehrere Monitore gleichzeitig müssten erst gebaut werden. Das war
falsch** — es ging aus „eine Aufnahmequelle je Stream" hervor, was nur je Stream
stimmt. Mehrere Streams gleichzeitig gibt es längst, mit eigener Monitorwahl je
Stream und Bedienung in der Oberfläche.

Seit dem 2026-08-12 (PR #321) zusätzlich:

- Die Obergrenze von vier gleichzeitigen Streams ist auf 99 gehoben — praktisch
  also weg; was möglich ist, entscheiden Encoder und Uplink. Die Zahl liegt
  jetzt an **einer** Stelle (`shared/src/dcc_shared/streaming.py`), vorher an
  fünf, eine davon unter anderem Namen.
- Ein Fehler behoben, der mit steigender Slot-Zahl gefährlich geworden wäre: Es
  gab nur zwei Merkfelder für die Aufnahmequelle, ab Slot 2 überschrieb eine
  Auswahl die von Slot 0 (`web/src/lib/stream/captureSource.ts`).

**Was für die Fernsteuerung offen bleibt** — und das ist jetzt der ganze Rest:

- **Eingabe-Frames brauchen eine Ziel-Angabe (Slot).** Das Wire-Protokoll v1
  kennt keine — es setzt genau eine Quelle voraus. Bei zwei laufenden Streams
  landete ein Klick sonst auf dem falschen Bildschirm. **Von Anfang an
  einbauen**, nachträglich ist es ein Protokollbruch.
- **Kosten sind linear**: je Monitor ein voller Encode und eine volle Bandbreite.
  Die Auflösungsstufen (unten) sind der Hebel dagegen.
- **Grenze, bewusst akzeptiert**: Zwei Streams sind zwei Bilder. Der Zeiger
  springt zwischen ihnen, statt über die Bildschirmkante zu wandern; ein Fenster
  von Monitor 1 nach 2 zu ziehen geht nicht.
  > **Aufgehoben am 2026-08-24.** Ziehen über die Fenstergrenze ist gebaut —
  > das Ursprungsfenster behält die Geste und zielt um, statt sie zu übergeben.
  > Der Zeiger springt weiterhin, statt über die Kante zu wandern; das bleibt.
  > Siehe `docs/superpowers/specs/2026-08-24-mehrere-host-bildschirme-design.md`
  > (Teil 1 für Windows/macOS/X11, Teil 5 für Wayland). Die Begründung hier
  > bleibt stehen, weil sie den damaligen Stand richtig beschreibt.
- Verworfen: alle Monitore in **ein** Bild (vier 4K nebeneinander = 15360×2160;
  auf eine übliche Box heruntergerechnet ist jeder Monitor darin briefmarkengroß).
- Billige Zwischenstufe, die Sunshine so fährt: **Monitor-Umschalten per
  Tastenkürzel** am steuernden Rechner (dort Strg+Alt+Umschalt+F1…F12), statt
  einen zweiten Stream zuzuschalten. Deckt den häufigsten Fall zu einem Bruchteil
  des Aufwands.

### Auflösung: das Herunterrechnen existiert bereits

`Native / 4K / 1440p / 1080p / 720p / 480p` als **Box**, in die aspektwahrend
eingepasst wird (`fit_within_box`, kein Upscale), plus die Server-Obergrenze
`hq_resolution_max`. Für die Fernsteuerung ist damit nichts zu bauen — vier 4K
Monitore sind kein Problem, man sendet sie kleiner.

**Offen, und ein echter Unterschied zu Parsec:** Parsec und Sunshine ändern die
*tatsächliche* Anzeige des gesteuerten Rechners, wir rechnen nur das fertige Bild
klein. Ein 4K-Desktop auf 720p geschrumpft ist flüssig, aber die Schrift ist nicht
mehr lesbar — zum Zusehen egal, zum Arbeiten der Unterschied zwischen brauchbar
und unbrauchbar. **Noch nicht entschieden**, aber nach der 4:4:4-Untersuchung
(unten) der einzige verbliebene Weg mit großer Wirkung.

Wie es die beiden lösen (recherchiert 2026-08-11, Quellen am Ende):

| | Weg | Preis |
|---|---|---|
| **Sunshine** | ändert die echte Anzeige: `dd_resolution_option: auto` setzt die vom Client angeforderte Auflösung, `dd_configuration_option: ensure_only_display` schaltet die übrigen Monitore ab, `dd_config_revert_on_disconnect` stellt zurück | Windows öffnet Programme auf dem abgeschalteten Monitor → unerreichbare Fenster; ohne das Zurückstellen verändert man die Konfiguration eines Rechners dauerhaft, an dem man nicht sitzt |
| **Parsec** | fasst die echten Monitore nicht an, sondern legt über einen eigenen Treiber (IddCx) bis zu drei **virtuelle** Bildschirme an, je Client mit passender Auflösung | ein Windows-Treiber, den wir ausliefern und signieren lassen müssten |
| **Apollo** (Sunshine-Ableger) | dasselbe über SudoVDA (640×480 bis 8K, 60–500 Hz), ein virtueller Schirm je Client, angelegt beim Start, entfernt beim Ende | wie Parsec |
| **wir heute** | nur das fertige Bild verkleinern | fasst nichts am fremden Rechner an — aber die Schrift bleibt unlesbar |

`ChangeDisplaySettingsEx` wäre der Sunshine-Weg; ein eigener Anzeigetreiber der
Parsec-Weg. Beides ist eine bewusste Entscheidung, keine Kleinigkeit.

### Farbschärfe (4:4:4): geprüft und verworfen (2026-08-11)

Volle Farbauflösung ist der Hebel, den ein Sunshine-Nutzer als **wichtiger als
die Auflösung** für lesbaren Text beschreibt, und Microsofts eigene Fernwartung
erzwingt sie. Vollständig untersucht in `docs/2026-08-11-farbschaerfe-444.md`.
Ergebnis:

- **Geht auf unserer Hardware nicht.** Nicht Transport und nicht Browser sind das
  Hindernis — die könnten es beide —, sondern der **Encoder**. VAAPI auf der
  780M lehnt in allen drei Codecs ab (gemessen). Der einzige mögliche Weg wäre
  NVIDIA-H.264, also unter Aufgabe von AV1; in Software scheitert es an der
  Lizenz (libx264 ist GPL, unsere FFmpeg-Bauten sind LGPL ohne Software-Encoder).
- **Nicht mit Bitrate zu erkaufen:** die Zehnfachung von 4 auf 40 Mbit/s bringt
  Luma +7,3 dB und Chroma **+0,005 dB**. Der Verlust ist strukturell.
- **Und er trifft weniger, als gedacht:** 4:2:0 kostet bei **grauem** Text 7,1 dB
  (visuell verlustfrei), bei **farbigem** 28,2 dB. Terminal, Dokument und
  Dateimanager sind unbeschädigt; der Leidtragende ist die Syntaxhervorhebung.
- **Gegenprobe:** unterhalb von rund 4 Mbit/s wäre 4:4:4 sogar **schlechter** —
  die Farbebenen nehmen dem Luma die Bits.

Damit bleibt als Reihenfolge: **1. Auflösung am Host umstellen** (greift Luma an,
wirkt überall, senkt sogar die Bitrate), **2. Nachschärfen im Player-Shader**
(CAS/FSR1, MIT-lizenziert; die Andockstelle zwischen Deband und Dither ist frei),
**3. Encoder-Abstimmung** (laut Messung fast wirkungslos).

### Koordinaten bleiben Anteile, nicht Pixel (geprüft 2026-08-11)

Rückfrage war, ob echte Pixelwerte genauer wären, jetzt wo der Player da ist.
**Nein — sie wären gröber.** Die 16-Bit-Normierung des Wire-Protokolls sind
65536 Stufen über die Bildbreite:

| Ziel | Stufen je Pixel |
|---|---|
| 1080p | 34 |
| 1440p | 26 |
| 4K | 17 |
| 8K | 8,5 |
| vier 4K nebeneinander | 4,3 |

Selbst über vier 4K-Monitore bleibt die Übertragung unterhalb der Pixelgrenze.
Dazu kommt der Robustheitsgrund, der mit der Monitor-Entscheidung oben direkt
zusammenhängt: Ein Anteil bedeutet auf jeder Auflösung dasselbe. Pixelwerte
verlangten, dass beide Seiten die Geometrie des Hosts kennen und einig sind —
bei Monitor-Wechsel, Auflösungsstufe oder zugeschaltetem Bildschirm müsste das
neu abgeglichen werden, und jede Verzögerung dabei setzt Klicks an die falsche
Stelle.

**Wo der Player die Genauigkeit wirklich hebt:** Die Grenze sitzt beim
Steuernden. Ein 800 Punkte breites Fenster auf einen 4K-Desktop bedeutet knapp
5 echte Pixel je Fensterpunkt — daran ändert kein Übertragungsformat etwas.
`winit` liefert Zeigerpositionen als `f64` und über `DeviceEvent::MouseMotion`
zusätzlich die rohen Gerätebewegungen; damit lässt sich zwischen zwei
Fensterpunkten weiter auflösen, und das Ergebnis passt bequem in die 65536
Stufen. Genau das kann ein Browser-`<video>` nicht liefern.

**Bestätigt durch Moonlight/Sunshine:** Die schicken die Pixel des
Zuschauer-Fensters **plus die Bezugsgröße** und rechnen erst beim Host in einen
Anteil zurück (`touch_port`, `scalar_inv`). Also derselbe Rechenweg, nur mit
einem Übertragungsschritt mehr. Dass unserer der robustere ist, steht in ihrem
eigenen Quelltext: dort ist ein Rundungsfehler von Nvidias Skalierung umschifft,
der den Zeiger nicht an den äußersten Bildrand kommen ließ — behoben, indem von
den Maßen eins abgezogen wird. Diese Fehlerklasse entsteht bei einem Anteil gar
nicht erst.

### Der lokale Mauszeiger (empfohlen, 2026-08-11)

Moonlight kann den Zeiger **beim Zuschauer** zeichnen, statt auf den fernen
Zeiger im Videobild zu warten (Strg+Alt+Umschalt+C). Nutzer beschreiben den
Unterschied als groß: mit fernem Zeiger fühlt es sich schlechter an als eine
gewöhnliche Fernwartung — man wartet, um zu sehen, wo der Zeiger landet, bevor
man klickt; mit lokalem Zeiger „als säße man am eigenen PC".

Das senkt die Latenz **nicht**, es versteckt sie — und zwar an der Stelle, an der
Verzögerung am stärksten auffällt. Für uns billig, weil der Player sein Fenster
ohnehin selbst zeichnet. Zwei Haken: der ferne Zeiger muss dann ausgeblendet
werden (sonst zwei Zeiger), und die Zeigerform (Textmarke, Größenänderung) müsste
mitübertragen werden, sonst zeigt man immer den Pfeil.

### Weiteres aus dem Vergleich (2026-08-11)

- **Hartes Abbruch-Kürzel** auf beiden Seiten (Moonlight: Strg+Alt+Umschalt+Q).
  Unser Not-Aus ist bisher nur ein Knopf.
- **Eingabe-Übernahme umschaltbar** — man will die Tastatur nicht dauerhaft am
  fernen Rechner haben.
- **Ihr Protokoll deckt sich sonst mit unserem**: relative Bewegungen als
  16-Bit-Werte und bei großen Sprüngen aufgeteilt, Scancodes statt Zeichen
  (ausdrücklich der Spielekompatibilität wegen), Sonderbehandlung der
  Extended-Tasten, zuverlässig und in Reihenfolge — mit der einen Ausnahme, dass
  veraltete Mausbewegungen verworfen werden dürfen. Das ist Wort für Wort unsere
  Flutkontroll-Regel. Sie haben zusätzlich waagerechtes Scrollen, Stift, Touch
  und Gamepad; Gamepad ist bei uns bewusst ausgeklammert.
- **Ihr Kopplungsmodell brauchen wir nicht.** Sunshine muss Vertrauen zwischen
  zwei Rechnern erst herstellen (PIN, danach Client-Zertifikat) — mit einer
  Sicherheitsmeldung in der Historie (Reihenfolge der Anfragen ungeprüft →
  Angreifer konnte sich einkoppeln, PIN offline durchprobierbar). Bei uns kennen
  sich beide Seiten bereits über das Konto; Zustimmung je Sitzung plus
  `REMOTE_CONTROL` ist weniger Arbeit **und** die sicherere Bauform.

**Quellen:** [Sunshine-Konfiguration](https://docs.lizardbyte.dev/projects/sunshine/latest/md_docs_2configuration.html)
· [Sunshine Tastatur/Maus](https://deepwiki.com/LizardByte/Sunshine/7.3-keyboard-and-mouse-input)
· [Sunshine `input.cpp`](https://github.com/LizardByte/Sunshine/blob/master/src/input.cpp)
· [moonlight-common-c `InputStream.c`](https://github.com/moonlight-stream/moonlight-common-c/blob/master/src/InputStream.c)
· [Erfahrungsbericht Mehrmonitor](https://zenn.dev/toki_mwc/articles/sunshine-moonlight-dev-remote-desktop?locale=en)
· [Sunshine-Anzeigeumschaltung](https://niquette.ca/articles/sunshine-displays/)
· [Apollo](https://github.com/ClassicOldSong/Apollo/blob/master/README.md)
· [SudoVDA](https://github.com/SudoMaker/SudoVDA)
· [Parsec VDD](https://support.parsec.app/hc/en-us/articles/32381178803604-VDD-Overview-Prerequisites-and-Installation)
· [parsec-vdd (Technik)](https://github.com/nomi-san/parsec-vdd)
· [Moonlight: lokaler Zeiger](https://github.com/moonlight-stream/moonlight-qt/issues/1268)
· [Moonlight-Tastenkürzel](https://docs.cloudypad.gg/help/moonlight-usage.html)
· [Sunshine-Sicherheitsmeldung](https://github.com/LizardByte/Sunshine/security/advisories/GHSA-3hrw-xv8h-9499)

## Reihenfolge

Jeder Schritt ist für sich prüfbar; nach Schritt 3 ist das Feature erlebbar.

| | Schritt | Ergebnis |
|---|---|---|
| 1 | M1 + Recht + Consent-UI von `feat/remote-control-windows` auf frisches `main` heben, `remote_signal` durch das Eingabe-Op ersetzen | Backend trägt Anfrage/Zustimmung/Ende, Tests grün |
| 2 | Eingabe-Erfassung im Player + stdio-Op + Durchreichen in Electron | Ein Tastendruck im Player-Fenster landet als Frame beim chat-gateway |
| 3 | Host-Seite: Frame → Sidecar → `remote_input.rs` | **2-Geräte-Test.** Klick im Player bewegt den Windows-Cursor |
| 4 | Rückweg messen (Tastendruck bis sichtbare Reaktion) | Die letzte offene Zahl |
| 5 | Feinschliff: Not-Aus, Anzeige beim Host, Monitore zuschalten | Auslieferbar |

Die **Slot-Angabe in den Eingabe-Frames** gehört in Schritt 1/2, nicht in
Schritt 5 — auch wenn das Zuschalten weiterer Monitore erst dort gebaut wird.

## Wie geprüft wird (offen, 2026-08-11 aufgeworfen)

Der Zwei-Geräte-Test braucht einen Weg, auf dem **belegt** wird, was am anderen
Rechner geschieht — nicht ein „sieht gut aus" aus zweiter Hand. Die
Sitzungs-Kopplung über Remote Control hat sich dafür als untauglich erwiesen:
zwei Antworten der Gegenstelle kamen am 2026-08-11 nie an, und ein ausbleibendes
Zustellen ist von hier aus nicht erkennbar (es gibt keinen abfragbaren
Posteingang).

**Entschieden und angefangen (2026-08-11/12):** OpenSSH-Server auf der
Windows-Maschine. Einrichtungs-Anweisung:
`docs/plans/2026-08-11-windows-bruecke-einrichten.md` (Branch
`docs/windows-bruecke`). **Stand:** Der Dienst läuft und ist im LAN erreichbar
(192.168.178.72, „OpenSSH for Windows 9.5"), die Schlüssel-Anmeldung wird aber
noch abgelehnt — offen ist der genaue Kontoname und ob der Schlüssel in
`C:\ProgramData\ssh\administrators_authorized_keys` mit den geforderten Rechten
liegt (die Falle aus §2 der Anweisung).

Damit wird jede Prüfung eine Messung statt einer Beschreibung:

| Frage | Verfahren |
|---|---|
| Landet ein Klick, wo er soll? | Zielpunkt senden, danach die echte Cursor-Position abfragen, Δ in Pixeln — das Verfahren des M0-PoC (Δ 0 px) |
| Kommen Tastendrücke an? | Editor öffnen, Text senden, Datei zurücklesen und vergleichen |
| Kommt das Bild, und wie schnell? | `latency-pattern.py` auf dem Windows-Schirm, `probe.rs` im Player liest zurück |
| Sieht es richtig aus? | Bildschirmfotos beider Seiten nebeneinander |

Nicht automatisierbar und **bewusst beim Menschen**: der Zustimmungs-Klick des
Gesteuerten.

**Windows-Release braucht einen Versions-Bump** (`desktop/package.json`) —
electron-updater ignoriert gleiche Versionen still (CLAUDE.md).

## Was offen bleibt

- **Der Rückweg ist nicht gemessen.** Rund 29 ms zu howispulse.com sind reine
  Laufzeit-Rechnung. Schritt 4 holt das nach.
- **Nicht gegen howispulse.com gemessen.** Die 55–85 ms sind aus der
  Umlaufzeit hochgerechnet; der Prüfstand kann auf dem Produktivserver seit dem
  2026-07-31 nicht mehr publishen.
- **Der 2-Geräte-Test steht weiterhin aus** — er stand schon im Juli aus. Ob
  Bild und Klicks wirklich zusammenfinden, weiß niemand.
- **Mixed-DPI ist nie real ausgeübt worden** (M0 lief auf drei Monitoren mit
  je 100 % Skalierung).
- **Kopf-an-Kopf Serverweg gegen P2P fehlt weiter.** Die Neubewertung stützt
  sich auf eine gemessene Seite (Server) gegen eine geschätzte (P2P). Sollte
  sich der Serverweg im 2-Geräte-Test als zu träge erweisen, ist der P2P-Code
  auf `feat/remote-control-windows` nicht verloren — er ist dann ein additiver
  Schnellpfad neben einem funktionierenden Feature statt seine Voraussetzung.
- **`streaming/win-input-poc/`** ist bisher nirgends erwähnt; beim Übernehmen
  in `THIRD-PARTY-NOTICES.md`/Größen-Policy mitdenken.

## Nächste offene Entscheidungen (Stand 2026-08-12)

1. **Brücke fertigstellen** — SSH läuft, die Schlüssel-Anmeldung noch nicht
   (s. „Wie geprüft wird"). Danach der Sitzungs-Helfer aus §3 der Anweisung; ohne
   ihn kann SSH bauen und lesen, aber nicht sehen.
2. **Auflösungs-Umschaltung am gesteuerten Rechner?** — nach der
   4:4:4-Untersuchung der einzige verbliebene Weg mit großer Wirkung. Zu
   entscheiden ist dabei nicht nur ob, sondern **welcher**: echte Anzeige ändern
   (Sunshine, billig, mit Nebenwirkungen) oder virtueller Bildschirm über einen
   eigenen Treiber (Parsec, sauber, aber ein signierter Windows-Treiber).
3. **Lokaler Mauszeiger** — aus meiner Sicht ein klares Ja, geringe Kosten, große
   Wirkung auf das Gefühl.

Danach beginnt Schritt 1 der Reihenfolge.

## Randfunde, die hier nicht hingehören, aber nicht verlorengehen dürfen

Beide sind bei der 4:4:4-Untersuchung angefallen und haben mit der Fernsteuerung
nichts zu tun:

- **`av1_vaapi` hat auf Standbild-Eingabe den Videoblock der GPU zum Absturz
  gebracht** (`vcn_unified_0 ring reset`, Bildschirm unbeeinträchtigt, saubere
  Erholung). Ob das im echten Sidecar-Betrieb auftreten kann — etwa bei einem
  statischen Bildschirm während einer Fernsteuerungssitzung — ist ungeklärt.
  Naheliegender Zusammenhang mit der seit 2026-08-06 bekannten „Stockung" der
  AMD-Video-Einheit (`streaming/pulse-player/src/stockung.rs`).
- **Die SDP-Zusage des WHIP-Sendewegs war falsch**: `sdp.rs` rechnete die
  H.264-Stufe aus der Bildgröße aus, `register_default_codecs()` überschrieb sie
  mit einer festen Liste. Am 2026-08-12 gemessen (1440p und 4K erzeugten
  Zeichen für Zeichen dasselbe Angebot) und auf Branch `fix/whip-sdp-zusage`
  repariert; dabei fiel auf, dass auch die Stereo-Zusage des Tons nie
  hinausging.
