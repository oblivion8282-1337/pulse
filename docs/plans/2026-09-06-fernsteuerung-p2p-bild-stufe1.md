# Fernsteuerung — P2P-Bild, Stufe 1: der Steuernde sieht den Stream direkt

Stand 2026-09-06. Vorgänger: `2026-08-13-fernsteuerung-p2p-eingabeweg.md` (Eingabe-P2P,
läuft), `2026-08-22-fernsteuerung-direktverbindung-bild.md` (Untersuchung, TURN fällt
weg), `2026-07-09-direct-path-webrtc.md` (Direktpfad des App-Hostings). Der gelöschte
Zweig `feat/remote-control-windows` (Answerer, ~7600 Z.) ist nachweislich nicht
wiederholbar: nie Gegenstand eines PR, also auch nicht unter `refs/pull/*`. Der
Answerer wird neu gebaut — kleiner, auf Stufe 1 zugeschnitten.

## Was Stufe 1 will — und was ausdrücklich NICHT

**Der Steuernde bekommt das Bild direkt vom Host**, Host→Steuernder in einer
WebRTC-Verbindung, der Server trägt nur noch das Signaling (ein paar SDP/ICE-Nachrichten)
und die Eingabe (die hat ihren eigenen P2P-Weg mit stillem Rückfall).

**Nicht-Ziele für Stufe 1:**
- Keine Zuschauer im P2P-Modus. Der normale „Übernehmen"-Weg (WHIP→MediaMTX→WHEP)
  bleibt unverändert und ist weiterhin der Weg für Zuschauer/Gäste.
- Kein zweiter Stream vom Host: Im P2P-Modus läuft der Stream **ausschließlich**
  direkt zum Steuernden. Nicht gleichzeitig WHIP und direkt (doppeltes Upload).
- Kein TURN, kein coturn-Anbindung (siehe 08-22-Doc §2: Pulse ist selbst das Relay,
  der Serverweg ist der still vorhandene Rückfall).
- Kein Wiederverbinden/Wandernd-Mitmachen: bricht die Direktverbindung, endet die
  Übernahme (der Nutzer startet neu — wahlweise auf dem Serverweg).

## Architektur

```
STEUERNDER                                     HOST
──────────                                     ────
DeviceView: Button „P2P“
  → geraetWecken(mit modus:'p2p')
  → Consent/remote_request wie gehabt
    (Der Server sieht vom Bild NICHTS.)
player: statt WHEP-POST →
  Offer (recvonly video+audio, DC pulse-input bleibt in p2p.ts)
  → remote_transport → Renderer ───── offer ────► Host-Renderer
                                                    → sidecar op „direct_accept“
Player legt RTP an ◄═══ RTP/RTCP direkt ═══════════┘
  (Sidecar ist ANSWERER, Trickle-ICE via remote_signal beide Wege)
Eingabe: unverändert über p2p.ts DataChannel (stiller WS-Rückfall bleibt)
```

### Wer offeriert, wer antwortet

Der **Player offeriert** (er kennt das Ziel nicht vorab und hat kein Token-Problem),
der **Sidecar antwortet**. Begründung gegen den Strich der alten Trennung
(„beide sind Offerer“): Der Sidecar kennt nach dem Start keinen Gegenüber —
die Sitzung lebt im Renderer. Der Player dagegen wird sowieso erst geöffnet, wenn
die Sitzung steht, und hat mit `whep.rs` bereits einen vollständigen webrtc-rs-PC,
dessen `set_remote_description`-Seite nur von POST-auf-MediaMTX auf
Signal-via-Renderer umgestellt werden muss.

### Der Empfänger ist der Player, nicht der Renderer

Wie beim WHEP-Weg gilt: Das Bild gehört in den nativen Player (Takt, FEC-losigkeit
verzeichnet, AV1/Codec-Probe). Der Renderer vermittelt nur das Signaling — dieselbe
Schiene wie `remote_transport` für Eingabe-Statistiken. Ein HTML-video-Fallback im
Renderer wird bewusst NICHT gebaut; zwei Bildwege zu pflegen wäre der teurere Preis.

### Modus-Flag durch den Weck-Weg

`device_wake` (und damit `geraetWecken`) bekommt ein Feld `p2p: true`:
- Host-Renderer: `streamStarten` startet den Sidecar **ohne** `push_url`, dafür mit
  `direct: true` (op `start` mit neuem Zweig in `ServerProfile`: kein MediaMTX-Pfad,
  kein Token, Encoder startet erst, wenn die Direktverbindung steht).
- Der Nachtwächter von `wecken.ts` („nach 90 s einschlafen, wenn niemand übernimmt“)
  läuft im P2P-Modus auf ein anderes Lebenszeichen: nicht `stream:active` (das
  schreibt der MediaMTX-Auth-Hook — der sieht nie etwas), sondern das
  Sidecar-Ereignis „Direktverbindung steht“, das der Host-Renderer als
  Geräte-Zustand meldet. Sonst legt sich der geweckte Rechner schlafen, bevor
  überhaupt jemand zuschauen kann.
- Der Steuernde wartet nicht auf `stream:active`, sondern auf das
  Zustands-Ereignis im Geräte-Fenster — gleiche Baustelle, gleiche Frist (25 s).

### Signaling: `remote_signal` reicht, aber erst nach dem Consent

`remote_signal` trägt heute `offer/answer/ice` (8-KiB-Grenze, 60/s, peer-bound)
und fließt nur in **aktiver** Sitzung — genau die Eigenschaft, die wir wollen:
Ohne Zustimmung des Hosts entsteht keine Direktverbindung, kein SDP verlässt den
Weg. Stufe 1 fügt KEINE neue Signalart hinzu und keinen Vorab-Pfad vor dem Consent.
Konsequenz: Der „P2P“-Button startet denselben Consent-Dialog wie „Übernehmen“.
Erst `remote_response: accept` schaltet den Signal-Weg frei, dann offeriert der
Player. (Der Weckruf läuft vorher — der host startet den Sidecar im Wartezustand,
Encoder idle, bis die Direktverbindung steht. Kosten: kaum; Gegenprobe im
Bug hunt: Sidecar-RAM im Leerlauf messen.)

### Sinks: der zweite „WhipSender“ ist ein DirektSender

`pulse-whip` kapselt heute Publish (WHIP-POST). Für die Direktvariante braucht der
Sidecar keinen zweiten Encoder — der Encoded-Frame-Zweig (`keyframe.rs`,
`pacer.rs`, goog-remb) bleibt, nur das Ziel ändert sich: statt RTCP von MediaMTX
kommt es vom Player. Neues Crate-Stück `pulse-whip::direct` (oder schlichtes
Feature im sidecar): PC aufbauen aus Remote-Offer, Track sendonly an den
Transceiver, RTP aus demselben Frame-Zweig speisen. **NACK wird gebraucht** —
auf der Direktstrecke gibt es kein FlexFEC (das erzeugt MediaMTX), NACK ist über
kurze RTT aber deutlich wirksam; `whep::sperre_aus_rtt` liefert die Grenze.
Keyframe on demand: PLI/FIR des Players → `request_keyframe`, existiert.

### Wiederverwendbares aus dem App-Hosting-Zweig

- `docs/plans/2026-07-09-direct-path-webrtc.md`: die webrtc-rs-Fallen
  (Mux-Mode ohne srflx → manuelle Kandidaten-Injektion; ICE-IP-Filter Pflicht;
  rustls-CryptoProvider explizit). Auf Windows gilt das für den SIDEcar-PC;
  der Player-PC (Antwortseite, kein Server) umgeht die Mux-Falle.
- Docker-bridge/VPN-Adapter blähen Kandidatenlisten auf (07-21-Doc §6.3):
  Interface-Filter von Anfang an einbauen, nicht nachrüsten.
- `web/src/lib/direct/` (TOFU-Registry, Verbindungspolitik) bleibt **außen vor** —
  sie dient dem Client↔Server-App-Pfad mit eigener Trust-Logik. Stufe 1 erbt das
  Vertrauen aus der Fernsteuerungs-Sitzung (Consent + Session), nicht aus einem
  Fingerprint-Register. Das ist weniger Code und die richtige Stufe.

## UI

`DeviceView.svelte`, unter dem „Übernehmen“-Knopf ein zweiter: **„P2P“**
(`data-testid="device-view-take-over-p2p"`), nur sichtbar, wenn der eigene
Gerätestand eine Fernsteuerung überhaupt anbietet (dieselbe Bedingung wie der
große Knopf, abzüglich laufender Übertragung). Tooltip/Untertext: „Direkt zum
Rechner, ohne Umweg über den Server — nur du siehst das Bild.“ Beide Knöpfe
führen in denselben Consent-Dialog; der Modus reist im `remote_request`
(`p2p: true`) und im Weckruf mit.

i18n: `device_view_wake_p2p` in `web/messages/{de,en}.json`.

## Testspuren

1. **Einheit**: Signal-Relay-Renderer-Seite (offer rein → sidecar, answer raus),
   Modus-Flag im Weckruf, Nachtwächter-Lebenszeichen im P2P-Modus.
2. **Rust**: `pulse-whip::direct`-PC gegen einen Offer aus Test-SDP;
   Keyframe-Anforderung erreicht `request_keyframe`; NACK-Sperre folgt
   `sperre_aus_rtt`.
3. **E2E über zwei Maschinen** (Windows-Host + Linux-Steuernder gegen Hetzner):
   Übernahme per P2P-Knopf, Bild steht, Eingabe läuft, Zwischenablage läuft,
   Serverweg-Button bleibt unberührt. Messung: Loop-Zeit Serverweg vs. P2P
   (das ist die Zahl, die die 08-22-Untersuchung noch schuldig blieb).

## Offene Punkte (bewusst auf Stufe 2 verschoben)

- Mehrere Steuernde/Zuschauer parallel (heißt: zweiter Sink plus MediaMTX).
- Automatischer Rückfall Serverweg bei missglücktem ICE (Stufe 1: Meldung
  „Direktverbindung fehlgeschlagen (Router/NAT)“, Nutzer entscheidet).
- Wandernde Geräte/Umzug während laufender Direktsitzung.
- IPv6-only-Strecken (beide Seiten heute IPv4-FIRST; Kandidatenlisten filtern
  ohnehin).
