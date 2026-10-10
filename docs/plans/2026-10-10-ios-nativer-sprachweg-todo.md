# iOS nativer Sprachweg — was noch zu tun ist

**Stand 2026-10-10 · Entwurf: [2026-10-10-ios-nativer-sprachweg-design.md](../superpowers/specs/2026-10-10-ios-nativer-sprachweg-design.md)**

Reihenfolge innerhalb der Blöcke ist ein Vorschlag, keine Festlegung.
Jeder Punkt mit „Gerät" ist nur am echten iPhone belegbar — der Mac hat
**kein Mikrofon**, der Simulator keine Hörmuschel.

## 0. Gebaut, aber noch nicht am Gerät geprüft

Diese zwei sind heute als Antwort auf ein gemeldetes Symptom entstanden
(„hängt, und Hörmuschel schaltet nicht") und noch unbelegt:

- [ ] **Stummschalten hebt die Spur nicht mehr auf.** Vorher ging die Session
      beim Stummschalten auf `.playback` zurück — und dort gibt es keine
      Hörmuschel. Jetzt wird die Spur gemutet statt aufgehoben. · Gerät
- [ ] **`audioBlocked` wird im nativen Zweig zurückgesetzt.** Die Sperre
      („Audio aktivieren") gehört zum WebKit-Weg; ein stehengebliebenes
      `true` liess die Oberfläche festgehängt aussehen. · Gerät

## 1. Lücken im nativen Weg

Auf dem nativen Weg heute leer oder wirkungslos. Alles davon war im Web da.

- [ ] **Taubstellen (Deafen)** — schaltet nichts; es gibt keine `<audio>`-
      Elemente mehr, die man stummschalten könnte
- [ ] **Push-to-Talk**
- [ ] **Lautstärke je Teilnehmer** — `RemoteAudioTrack.volume` ist da, aber
      Zugriff blockiert den rufenden Thread (nicht vom Hauptthread rufen)
- [ ] **Geräteliste** (Bluetooth, AirPlay) im Ausgabe-Menü
- [ ] **Mikrofon-Test und Selbst-Mithören** (`micTest`, `selfMonitor`)
- [ ] **Pegel und Sprechringe** — bleiben bewusst nativ, müssen also in der
      nativen Ansicht gezeichnet werden (Etappe 3)
- [ ] **Token-Erneuerung** bei langen Gesprächen (`tokenLaeuftAb` → Web holt
      ein neues, reicht es durch)
- [ ] **Abgleich nach Reload** — `zustand()` fragen, statt den Raum zu
      verlieren. Nativ überlebt er den Reload; das ist ein Gewinn gegenüber
      heute, aber nur wenn die Oberfläche ihn aufnimmt

## 2. Etappe 3 — native Kanalansicht

- [ ] SwiftUI-Ansicht, über der WebView präsentiert
- [ ] Teilnehmerkacheln mit Video (Kamera, Bildschirmfreigaben) über
      `VideoView`/`SwiftUIVideoView`
- [ ] Kamera an/aus, Front/Rück
- [ ] **Zurück-Geste und Wischen schliessen die ANSICHT, nicht den Raum** —
      sonst legt eine Wischgeste versehentlich auf
- [ ] Web-Leiste bekommt einen Griff „zurück in den Kanal"
- [ ] Die Web-Route wird weiter gewechselt (Android-Zurück, Tiefenlinks,
      Wiederherstellen nach Reload hängen an der URL)

## 3. Etappe 4 — Anrufe

- [ ] CallKit an denselben nativen Raum
- [ ] **Anruf gewinnt gegen den Sprachkanal** (Eigentümer-Entscheid
      2026-10-10): Anruf annehmen → Kanal bleibt bestehen, schweigt;
      auflegen → zurück in den Kanal
- [ ] **Hörmuschel im Anruf geht über den ZWEITEN Weg.** Führt CallKit, ist
      die automatische Session-Konfiguration aus und
      `isSpeakerOutputPreferred` wirkungslos — dann stellt die Hülle die
      Route selbst. Die beiden Wege dürfen einander nicht überschreiben;
      `Anrufverwaltung.callkitAktiv` entscheidet, welcher gilt · Gerät

## 4. Etappe 5 — Aufräumen

- [ ] iOS-Sonderweg in `platform/iosTon.ts` für den Sprach-Modus abbauen
      (der Wiedergabe-Modus bleibt: HQ-Streaming läuft weiter im WebView)
- [ ] `AudioSessionPlugin.setVoiceActive` verliert seinen Sprach-Aufrufer
- [ ] Notschalter `NATIVER_SPRACHWEG_AN` entfernen, wenn der Weg steht
- [ ] Debug-Prüfpfad (`-PulseSpracheProbe`) behalten oder bewusst entfernen

## 5. Messungen, die ausstehen

- [ ] **Stream-Ton und Sprache gleichzeitig** — das grösste Risiko. Dann
      spielt WebKit (Stream) neben dem nativen Raum: dieselbe Konstellation
      zweier Sessions, die am 2026-10-10 zwei Mikrofon-Fehler verursacht hat,
      nur mit vertauschten Rollen · Gerät
- [ ] **Hört man die Gegenseite?** Am 2026-10-10 nie gemessen — der Mac hat
      kein Eingabegerät, es gab keine Gegenstelle mit Ton · Gerät + zweiter
      Teilnehmer
- [ ] **Rauschunterdrückung:** auf dem nativen Weg filtert Apple statt
      RNNoise. Ob das besser oder schlechter klingt, ist ungemessen — und nur
      zu hören, nicht zu rechnen · Gerät + Ohr
- [ ] **Gesperrter Bildschirm** — XCUITest kann die Seitentaste nicht
      drücken, `idevicediagnostics sleep` trennt die USB-Verbindung. Nur von
      Hand · Gerät
- [ ] **Bluetooth, Auto** · Gerät + Hardware
- [ ] **Gast-Links auf iOS:** fällt ein Gast in den nativen Weg oder bleibt
      er im Web? Nicht entschieden

## 6. Daneben, aus demselben Tag

- [ ] **Playwright: 3 rote Tests auf `main`** (`mobile-rooms`,
      `mobile-treffflaechen`, `plugins`, Stand 2026-08-26). Ein dauerhaft
      roter Test meldet keine Regression mehr
- [ ] **Changelog-Eintrag** — ganz zuletzt, vor dem Deploy
- [ ] Nichts ist gepusht: die Commits liegen lokal auf `feat/ios`

## 7. Restliche iOS-Roadmap

Unabhängig vom Sprachweg, aus `docs/plans/ios-roadmap.md`:

- [ ] 29 Bild-in-Bild · 28 Live Activity · 41 · 45 · 46 · 47 · 48
- [ ] 33 — eigener Branch, nach `feat/ios`
- [ ] 16 Universal Links — Entitlement wirkt erst nach nativem Neubau, AASA
      erst nach einem Prod-Deploy
