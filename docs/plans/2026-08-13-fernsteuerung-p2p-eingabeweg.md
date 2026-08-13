# Fernsteuerung: P2P-Eingabeweg — Integrationsplan (kein Neubau)

Stand 2026-08-13. Gehört zur Latenz-Offensive vom selben Tag
(Branch `feat/fernsteuerung-latenz`: Cursor-Echo, Player-Quickwins,
Senden-bei-Ankunft). Dieses Dokument beschreibt den vierten Baustein, der
dort bewusst NICHT mitgebaut wurde — und warum.

## Ausgangslage

Der geschlossene Kreis (Eingabe hin, Bild zurück) trägt über den Serverweg
rund **116 ms Netz** (gemessen 2026-08-12, `app/takt/fernsteuerung.rs`).
Die Software beider Seiten liegt nach der Latenz-Offensive bei zusammen
grob 15–25 ms — **das Netz ist jetzt der einzige große Posten**, und über
einen Relay-Server ist er nicht weiter zu senken. Direktverbindung
(gleiche Stadt: RTT 5–30 ms) halbiert bis viertelt den Kreis.

## Warum kein Neubau

Der P2P-Weg existiert bereits — vollständig — auf
`feat/remote-control-windows`: WebRTC-Controller, Signaling-Schicht,
Input-Encoder, Electron-Host-Brücke, TURN-Cred-Endpoint samt
coturn-Config, Consent-Dialoge; fünf Bughunt-Runden (Consent gehärtet,
TURN-Creds nur für Session-Peers, Teardown-Races behoben). Rund 7600
Zeilen über 72 Dateien.

Er ist nicht gemergt, weil (a) der Zwei-Geräte-Test aussteht und (b) der
Serverweg (Wire-Protokoll v2) ihn im Juli überholt hat: `main` hat
inzwischen ein EIGENES `web/src/lib/remote/` (session.svelte.ts,
RemoteControllerInput, sidecarInput), das mit dem Branch-Stand kollidiert.
Ein blinder Merge oder ein Neubau in derselben Session wie die
Latenz-Offensive dupliziert bzw. zerlegt gehärtete Arbeit.

## Der Plan: Eingabe zuerst, Bild später

**Stufe 1 — nur der Eingabeweg über den DataChannel.** Kleinster Schnitt
mit größtem Verhältnis von Gewinn zu Risiko:

- Die **Frames bleiben wortgleich** — die Wire-Spec v2 hat den `slot`
  bewusst in die Hülle gelegt, damit Serverweg und P2P dasselbe
  Frame-Format tragen. Der Sidecar-Parser (`remote_input/`) bleibt
  unangetastet; nur der Träger wechselt.
- **Signaling über `remote_signal`** — der Weiterleiter steht auf `main`
  im Gateway (ws_remote_handlers.py) und ist genau dafür stehengeblieben
  („billige Rückfahrkarte").
- **Controller-Seite im pulse-player**, nicht im Renderer: die Erfassung
  sitzt dort (`fernsteuerung/`), und webrtc-rs ist wegen WHEP ohnehin im
  Binary. Ein zweiter PeerConnection mit einem DataChannel
  (unreliable wäre falsch: die Spec verlangt zuverlässig + in Reihenfolge
  je Strom — DataChannel im Default-Modus liefert genau das).
- **Host-Seite im win-hq-sidecar**: webrtc-rs steckt auch dort (WHIP).
  Der Answer-Peer nimmt DataChannel-Nachrichten an und ruft dieselbe
  `Sitzung::frames`-Kette wie der stdio-Weg.
- **Serverweg bleibt als Rückfallebene** und für die Übergangszeit, in
  der ICE noch verhandelt: Frames laufen über WS, bis der Kanal offen
  ist; dann Umschalten mit frischem Hello (= „neuer Eingabestrom", die
  Spec deckt das ab).

**Stufe 2 — auch das Bild P2P** (Sidecar-Abgriff aus dem Branch): erst
wenn Stufe 1 im Feld läuft. Das Bild über den Server zu lassen ist
verkraftbar (Einweg ~60 ms), die Eingabe ist die Hälfte des Kreises.

**Aus dem Branch übernehmen, nicht neu schreiben:** `iceConfig.ts`
(TURN-Naht), der TURN-Cred-Endpoint samt coturn-Config und die
Consent-/Teardown-Härtungen — die fünf Bughunt-Runden dort sind genau die
Fehler, die ein Neubau alle noch einmal machte.

## Sicherheitsrahmen (unverändert gegenüber dem Branch)

- DataChannel-Eingabe erst NACH demselben Consent wie der Serverweg;
  der Sidecar bleibt fail-closed (unbekannter Opcode → Sitzung tot).
- TURN-Credentials nur für die zwei Session-Peers, kurzlebig.
- Kein Vertrauen in die Hülle: der Sidecar prüft weiter selbst
  (Grenzen 32 Frames / 1024 Byte gelten je Nachricht, egal welcher Träger).

## Erwarteter Gewinn

| Strecke | Eingabeweg heute (Server) | P2P direkt |
|---|---|---|
| Teststrecke (RTT 58 zum Server) | ~55–85 ms | RTT/2 der Direktstrecke, typ. 5–25 ms |
| gleiche Stadt | ~60 ms | ~5 ms |
| TURN-Fallback | ~60 ms | ≈ Serverweg (kein Verlust) |

## Offene Vorbedingungen

1. Zwei-Geräte-Test der Latenz-Offensive (A–C) — erst messen, was der
   Serverweg jetzt kann; das Verfahren steht in
   `docs/plans/2026-08-12-zwei-geraete-test-aufbau.md`.
2. Entscheidung, ob `feat/remote-control-windows` als Ganzes rebased wird
   oder Stufe 1 die Teile einzeln herüberzieht (Empfehlung: einzeln —
   der Branch trägt auch das teure Bild-P2P-Stück, das Stufe 2 ist).
