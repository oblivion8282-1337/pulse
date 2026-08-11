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

## Reihenfolge

Jeder Schritt ist für sich prüfbar; nach Schritt 3 ist das Feature erlebbar.

| | Schritt | Ergebnis |
|---|---|---|
| 1 | M1 + Recht + Consent-UI von `feat/remote-control-windows` auf frisches `main` heben, `remote_signal` durch das Eingabe-Op ersetzen | Backend trägt Anfrage/Zustimmung/Ende, Tests grün |
| 2 | Eingabe-Erfassung im Player + stdio-Op + Durchreichen in Electron | Ein Tastendruck im Player-Fenster landet als Frame beim chat-gateway |
| 3 | Host-Seite: Frame → Sidecar → `remote_input.rs` | **2-Geräte-Test.** Klick im Player bewegt den Windows-Cursor |
| 4 | Rückweg messen (Tastendruck bis sichtbare Reaktion) | Die letzte offene Zahl |
| 5 | Feinschliff: Not-Aus, Anzeige beim Host, Mehrfach-Monitor | Auslieferbar |

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
