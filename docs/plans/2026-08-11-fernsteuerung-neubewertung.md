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

### Mehrere Monitore: mehrere Streams, zuschaltbar (entschieden 2026-08-11)

Aufgenommen wird heute **eine** Quelle (`CaptureSource`: Primärmonitor, Monitor
per Index, Fenster per Titel/HWND). Vorbild Parsec: **der Hauptmonitor startet,
weitere Monitore sind während der Sitzung zuschaltbar** — je Monitor ein eigener
Stream. Die Slot-Mechanik dafür existiert
(`docs/plans/2026-06-23-multi-hq-stream.md`, Pfad `…-s<slot>-<nonce>`); es fehlt
die Bedienung und eine Protokoll-Ergänzung:

- **Eingabe-Frames brauchen eine Ziel-Angabe (Slot).** Das Wire-Protokoll v1
  kennt keine — es setzt genau eine Quelle voraus. Bei zwei zugeschalteten
  Monitoren landete ein Klick sonst auf dem falschen. **Von Anfang an
  einbauen**, nachträglich ist es ein Protokollbruch.
- **Kosten sind linear**: je zugeschaltetem Monitor ein voller Encode und eine
  volle Bandbreite. Die Auflösungsstufen (unten) sind der Hebel dagegen.
- **Grenze, bewusst akzeptiert**: Zwei Streams sind zwei Bilder. Der Zeiger
  springt zwischen ihnen, statt über die Bildschirmkante zu wandern; ein Fenster
  von Monitor 1 nach 2 zu ziehen geht nicht.
- Verworfen: alle Monitore in **ein** Bild (vier 4K nebeneinander = 15360×2160;
  auf eine übliche Box heruntergerechnet ist jeder Monitor darin briefmarkengroß).

### Auflösung: das Herunterrechnen existiert bereits

`Native / 4K / 1440p / 1080p / 720p / 480p` als **Box**, in die aspektwahrend
eingepasst wird (`fit_within_box`, kein Upscale), plus die Server-Obergrenze
`hq_resolution_max`. Für die Fernsteuerung ist damit nichts zu bauen — vier 4K
Monitore sind kein Problem, man sendet sie kleiner.

**Offen, und ein echter Unterschied zu Parsec:** Parsec schaltet die
*tatsächliche* Bildschirmauflösung des gesteuerten Rechners um, wir rechnen nur
das fertige Bild klein. Ein 4K-Desktop auf 720p geschrumpft ist flüssig, aber
die Schrift ist nicht mehr lesbar — zum Zusehen egal, zum Arbeiten der
Unterschied zwischen brauchbar und unbrauchbar. Windows kann das
(`ChangeDisplaySettingsEx`); der Preis ist, dass die Fenster des Gesteuerten
dabei umgeräumt werden und nach Sitzungsende nicht von selbst zurückspringen.
**Noch nicht entschieden.**

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

Vorgeschlagen und **noch nicht entschieden**: OpenSSH-Server auf der
Windows-Maschine einschalten. Damit wird jede Prüfung eine Messung statt einer
Beschreibung:

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

## Nächste offene Entscheidungen (Stand 2026-08-11, hier unterbrochen)

1. **SSH-Zugang auf der Windows-Maschine einschalten?** — Voraussetzung dafür,
   dass der Zwei-Geräte-Test überprüfbar statt beschrieben ist (s. „Wie geprüft
   wird"). Einmalige Einrichtung durch den User.
2. **Auflösungs-Umschaltung am gesteuerten Rechner nach Parsec-Art?** — der
   Unterschied zwischen „flüssig, aber unlesbar" und „arbeitsfähig" bei einem
   4K-Host (s. „Auflösung").

Danach beginnt Schritt 1 der Reihenfolge.
