# Übergabe: APK Voice nativ — Ton über Anruf-Wiedergabe

> Stand: 2026-10-05 · Branch `jules_mobile` (Basis: main `abdd0f57`) · Autor: Michael + ZCode-Analyse (Sitzung 2026-10-05)
>
> Decision-Record **und** Übergabe für die Umsetzung. Bewusst self-contained, aber
> nur für das Voice-Thema — die allgemeine Mobile-Architektur (Capacitor-Hülle,
> Remote-Web, Services) steht in `docs/UEBERGABE-MOBILE.md` (2026-09-06) und wird
> hier nicht wiederholt. Es ist **noch nichts implementiert** — dieses Dokument
> hält Analyse, Entscheidung und Arbeitspakete fest.

---

## 1. Auftrag & Entscheidung (Michael, 2026-10-05)

**Problem.** In der Android-APK läuft sämtlicher Sprachkanal-Ton über die
**Medien-Wiedergabe** (`STREAM_MUSIC`/`USAGE_MEDIA`, Medien-Lautstärkeregler),
nicht über die **Anruf-Wiedergabe** (`STREAM_VOICE_CALL`/`USAGE_VOICE_COMMUNICATION`).
Mit verbundenem Bluetooth wirkt es zufällig korrekt (dazu §2.3) — am eingebauten
Lautsprecher folgt der Ton dem falschen Regler, und die vom Router auf Anruf
umgebogenen Lautstärketasten regeln ins Leere.

**Entscheidung.** Sauber lösen, nicht mehr symptombekämpfen: Der Voice-Motor des
Sprachkanals wird **nativ in die Android-App verlagert** (LiveKit-Android-SDK) —
Wiedergabe **und** Mikrofon ab Geburt im Anrufkanal. Die Bedienung bleibt
vollständig in der Web-Oberfläche. Umsetzung auf diesem Branch.

**Bewusste Nicht-Ziele (bleiben erstmal in der Medien-Wiedergabe, Michael 05.10.):**

- Ton von **Bildschirmfreigaben** im Sprachkanal (`ScreenShareTile`)
- **Watch-Party**-Audio (Video-Player)
- **Stream-Schauen** (WHEP-Player)
- Klang-Kategorien `notification` / `ui` / `stream` (Chat-Klänge, UI-Klänge,
  Stream-Start/Stop)

Nur die Klang-Kategorie **`voice`** (Join/Leave/Mute/Deafen-Sounds) wandert mit.

---

## 2. Ist-Analyse (code-verifiziert, 2026-10-05)

### 2.1 Wer spielt welchen Ton ab — die komplette Liste

Es gibt **keinen nativen Code, der Audio abspielt**. Die APK ist eine
Capacitor-8-Hülle um die System-WebView (Chromium); jeder Ton wird im Web-Code
als HTML-Media-Element erzeugt und landet damit im Medien-Pfad der WebView:

| Ton | Erzeugung (repo-relativ) | Kanal heute |
|---|---|---|
| Stimme der anderen | `web/src/lib/voice/audioElements.ts`, Mobile-Zweig in `attach()` (ca. Zeile 135): ungemutete `<audio>`-Elemente je Teilnehmer (`srcObject`) | Medien |
| ScreenShare-Ton | `web/src/lib/components/ScreenShareTile.svelte` (~200): Element, optional Web-Audio-Boost (nur Desktop-Graph) | Medien |
| Watch-Party | `web/src/lib/watch/players/NativeVideoPlayer.svelte` / `WatchBackgroundFrame.svelte` (Video-Element) | Medien |
| Stream schauen | `web/src/lib/stream/components/WhepPlayer.svelte` (Video-Element) | Medien |
| Klänge (`voice.*`, `notification.*`, `ui.*`, `stream.*`) | `web/src/lib/sounds/engine.ts` (`new Audio()`), Katalog in `registry.ts`; `voice.*`-Aufrufer: `livekit.svelte.ts`, `web/src/lib/ws/voiceDiff.ts` | Medien |
| 1:1-Anrufe (Stimme + Klingeln) | `web/src/lib/anrufe/anruf.svelte.ts` (`track.attach()` → `<audio>`; Klingeln = `notification.dm`) | Medien |
| Mikrofon-Monitor (Hör-Test) | `livekit.svelte.ts` ~1602 (`new Audio()`) | Medien |

Der `<audio>`-Pfad auf Mobile ist **bewusst** so: Android suspendiert einen
hintergrundeten `AudioContext` binnen Sekunden nach Bildschirm-Sperre und der
Anruf verstummt; ein ungemutetes `<audio>`-Element überlebt als
„Hintergrund-Media" (gekoppelt mit einer MediaSession als Tarnung, siehe §3
Rückbauliste). Diese Absicht nicht unbesehen „reparieren".

### 2.2 Was die native Seite heute macht — und was sie nicht kann

`mobile/android/app/src/main/java/com/howispulse/app/SpeakerphoneRouter.java`
(wird bei Join via Bridge `AudioRoute.setVoiceActive` bedient, Aufruf im Web:
`web/src/lib/platform/audioRoute.ts`; Join-Reihenfolge in
`web/src/lib/voice/livekit.svelte.ts` ~440: **vor** `room.connect()`, weil
Android laufende AudioTracks an ihren Stream pinnt):

1. `MODE_IN_COMMUNICATION` selbst setzen — die System-WebView macht das bei
   reiner WebRTC-Wiedergabe **unzuverlässig** (mehrmonatiger Feldbefund, ganze
   Re-Assert-Maschinerie im Router: Mode-Listener, verzögertes Re-Apply 150/500 ms,
   Communication-Device-Listener gegen Chromium-Override).
2. `setVolumeControlStream(STREAM_VOICE_CALL)` — lenkt **nur die Tasten**, nie
   den Ton selbst.
3. BT aktiv pinnen: API ≥ 31 `setCommunicationDevice(BT-SCO/BLE)`, API < 31
   `startBluetoothSco()`; Recovery via `AudioDeviceCallback` (BT verbindet sich
   erst nach dem Join); Samsung/OneUI-Quirk via `setSpeakerphoneOn`.
   Geräteauswahl-UI: `AudioRoutePlugin.listRoutes` ↔ Route-Popup im Web.

**Der Kernpunkt:** Diese drei Hebel steuern nur **Weg** (welches Gerät) und
**Tasten**. Der „Stempel" — welcher Regler dem Ton folgt (Usage des AudioTracks) —
wird von **Chromium beim Track-Erzeugen** gesetzt. Es gibt weder eine Web-API
(„spiel das als Anruf ab") noch ein Android-API („stempel diesen laufenden Track
um"). Der Stempel lässt sich nur am Entstehungsort ändern — deshalb Option 2
(nativ), deshalb scheitert die „einfache Lock"-Idee (Diskussion mit Michael,
05.10.).

Der Halbweg „Ton im Web abgreifen und PCM über die Bridge an Android reichen"
wurde geprüft und **verworfen**: Der Abgriff braucht einen Web-Audio-Kontext —
genau der wird beim Sperrbildschirm suspendiert. Wir würden den
Sperrbildschirm-Bug zurückkaufen, um den Regler-Bug loszuwerden.

### 2.3 Warum Bluetooth „schon immer richtig" wirkt

Der SCO-Aufbau (Telefon-Freisprech-Profil) suspendiert A2DP (Medien-Funkweg) —
BT kann nur eine Leitung richtig. Der als „Medien" gestempelte Ton hat danach
keine Wahl und läuft durch die Telefonleitung, deren Volumen-Domäne der
Anruf-Regler ist. **BT maskiert den falschen Stempel, er ändert ihn nicht.** Am
eingebauten Lautsprecher gibt es keinen Leitungs-Wechsel, also bleibt der
Medien-Stempel sichtbar.

---

## 3. Zielbild

- **APK:** nativer Voice-Client (LiveKit-Android-SDK) übernimmt im Sprachkanal
  Join, Mikrofon-Aufnahme und Wiedergabe; beides mit
  `USAGE_VOICE_COMMUNICATION` → Anrufkanal. Sprachkanal **im Browser/Desktop
  bleibt unverändert** auf der Web-Engine — alles hinter dem Gate
  `isCapacitorAndroid()` (`web/src/lib/platform/runtime.ts`).
- **Bedienung bleibt im Web:** Teilnehmerliste, Stumm/Taub, Verlassen,
  Kanalwechsel, Sprech-Indikatoren, Route-Popup. Die Web-`VoiceRoom`-Fassade
  (`livekit.svelte.ts`) bleibt Anlaufstelle der UI und schaltet intern auf die
  native Bridge um. Neue Capacitor-Brücke (Muster existiert mehrfach:
  `AudioRoutePlugin`, `AnrufPlugin`, `VideoCapturePlugin`, `ShareReceiverPlugin`,
  `OrientationLockPlugin`).
- **Join-Parameter wiederverwenden:** Der bestehende Flow holt
  `resp.ws_url` + `resp.token` vom voice-signaling-Service
  (`livekit.svelte.ts`, `room.connect(resp.ws_url, resp.token)`). Genau diese
  zwei Angaben nativ übergeben — kein neuer Token-Weg.
- **`SpeakerphoneRouter` bleibt** für die Geräteauswahl (Lautsprecher/Ohr/BT),
  wird aber voraussichtlich vereinfachbar (§5 Punkt „Doppel-Zahlung").
- **`voice.*`-Klänge wandern nativ** (SoundPool/AudioTrack mit Anruf-Usage) —
  kleiner Nachzügler, siehe P5.
- **Rückbau der Tarn-Tricks im APK-Zweig** (alle hinter demselben Gate
  stilllegen, Web/Desktop unangetastet):
  - MediaSession-Kamuflage „Anruf tarnt sich als Musik" —
    `web/src/lib/voice/mediaSession.ts`
  - WakeLock (`#ensureWakeLock` + `#onVisible`-Mikrofon-Recovery in
    `livekit.svelte.ts`)
  - `audioBlocked`-Reparatur (`unblockAudio`, Autoplay-Gesture-Hinweise in
    `ChannelList.svelte` / `VoiceChannelView.svelte`)
  - `<audio>`-Anker-Pfad in `audioElements.ts` (Mobile-Zweig) wird im
    APK-Fall nicht mehr gebraucht (Browser-Android schon noch)

---

## 4. Arbeitspakete

**P1 — Versuchsaufbau / Kernprobe (der entscheidende Schritt).** SDK einbinden,
nativ nur-Zuhören-Join über die Bridge (Token aus bestehendem Web-Flow), Ausgabe
mit `USAGE_VOICE_COMMUNICATION`.
*Akzeptanz:* Am eingebauten Lautsprecher folgt der Ton dem **Anruf-Regler**;
der Medien-Regler hat keinen Einfluss; Lautstärke-HUD zeigt Anruf.
Erst bei Grün weiterbauen; bei Rot → Fallback-Diskussion (§7).

**P2 — Mikrofon + Steuerwege.** Mic nativ publishen; Stumm/Taub/Verlassen/
Kanalwechsel über die Bridge; Zustand zurück ans Web (Teilnehmer, Sprechen,
Verbindungsqualität, Mute-Zustände) in die bestehenden Stores, damit die UI
unverändert weiterläuft.

**P3 — Rückbau der Tarn-Tricks** (Liste §3) im APK-Zweig.

**P4 — Geräteklassen-Tests** (Matrix §6).

**P5 — `voice.*`-Klänge nativ** (SoundPool mit Anruf-Usage) + Diagnose-Snapshot
erweitern (`AudioRoute.snapshot` um native-Engine-States ergänzen).

**Danach, eigene Entscheidung, nicht Teil dieses Pakets:** 1:1-/Gruppen-Anrufe
(`anruf.svelte.ts`) auf denselben nativen Motor — gleiche Medien-Falle, gleiche
Lösung.

---

## 5. Fallstricke / während der Umsetzung zu entscheidende Punkte

1. **Zwei Motoren, ein Produkt.** Browser/Desktop behalten die Web-Engine —
   Sprach-Features müssen künftig doppelt gepflegt werden. Der
   Feature-Paritäts-Katalog (web-seitig heute):
   - RNNoise-Rauschfilter im Sendepfad (`web/src/lib/voice/noiseFilter.ts`,
     `setProcessor`/`createSendProcessor`) + Input-Makeup-Gain → nativ Ersatz
     (mindestens Android `NoiseSuppressor`/`AcousticEchoCanceler`); Feature-Flag
     `settings.audio.noiseSuppression` muss nativ wirken oder ehrlich deaktiviert
     werden.
   - PTT-Modus, Mikrofon-Pegel/Meter (`#feedSendMeter`, `#attachLocalAnalyser`),
     Sprech-Indikator für Remote (`remoteSpeakingTracker.ts`, heute
     AudioContext-basiert — nativ über SDK-Level-Meter lösen).
   - Deafen, Per-User-Lautstärke, Master-Lautstärke (Mobile heute Clamp 0..1 via
     Element-Volume; nativ kann mehr — Verhalten bewusst dokumentieren, nicht
     still ändern), Reconnect/Kanalwechsel, screen-mute während
     Bildschirmfreigabe.
2. **Doppel-Zahlung des Audio-Modes.** LiveKit-SDK bringt eigenes Audio-Switching
   mit und setzt den Mode ggf. selbst — `SpeakerphoneRouter` setzt ihn auch.
   Einen Eigentümer festlegen (Empfehlung: SDK für Mode/Playout, Router nur noch
   für Geräteauswahl-UI), sonst Mode-Ping-Pong. Das Route-Popup
   (`listRoutes`/`setRouteDevice`) an den AudioSwitch des SDK anbinden oder
   Router belassen — Decide bei P2.
3. **Version-Skew remote Web ↔ installierte APK.** Die WebView lädt das
   PRODUKTIONS-Web (`server.url` in `mobile/capacitor.config.json`); die APK
   rollt langsamer. Jeder Bridge-Aufruf capability-gated (Plugin fehlt/zu alt →
   still auf Web-Pfad fallen) — Vorbild: `audioRoute.ts` fängt jeden Call ab.
4. **Sperrbildschirm/Mikrofon.** `MicForegroundService` (FGS type microphone)
   weiter nutzen; native Aufnahme braucht ihn ebenfalls. Prüfen, ob das SDK
   eigene FGS-Erwartungen hat.
5. **Telefonie-Randfälle.** Echter GSM-Anruf mitten im Sprachkanal
   (`AUDIO_BECOMING_NOISY`, Fokus-Rückgabe), BT mitten im Anruf an/aus,
   Multi-Device-Wechsel — siehe Matrix.
6. **SDK-Version pinnen** (gradle), Voice-Server ist Standard-LiveKit
   (voice-signaling-Service stellt Token); nichts Serversseitiges ändert sich.

---

## 6. Test-Matrix (P4)

| Fall | Erwartung |
|---|---|
| Eingebauter Lautsprecher | Ton folgt Anruf-Regler; Medien-Regler ohne Einfluss; HUD „Anruf" |
| Hörmuschel / Kabel-Headset | dito, sauberes Umschalten |
| BT-Headset (SCO **und** BLE) | Ton über Anruf-Regler; BT erst nach dem Join verbinden → übernimmt |
| Auto (A2DP → SCO beim Einsteigen) | kein „im Auto zu leise"-Rückfall |
| Sperrbildschirm ≥ 5 Min | Ton + Mic bleiben; Entsperren ohne Aussetzer |
| GSM-Anruf mitten im Sprachkanal | Sprachkanal paukt, danach saubere Rückkehr |
| BT mitten im Anruf an/aus | deterministischer Wechsel, Router/SDK kein Ping-Pong |
| Verlassen / Kanalwechsel | Mode/Route werden freigegeben (heute fängt
  `SpeakerphoneRouter.setVoiceActive(false)` das ab — Referenzverhalten) |
| API < 12 Gerät | `startBluetoothSco`-Pfad (Router) bzw. SDK-Äquivalent |
| Diagnose | `AudioRoute.snapshot()` (mode/streams/devices) beim Join an
  `/audio-diagnostic`; `dumpsys audio` am Gerät zeigt Track-Usages |

---

## 7. Offene Punkte für später

- **Watch-Party-/ScreenShare-Ton** bleibt Medien-Regler (akzeptiert, 05.10.) —
  Trennung „Anruf-Regler = wer spricht, Medien-Regler = was geschaut wird" ist
  vertretbar und Discord-ähnlich. Zweiter Umbau, falls irgendwann gewünscht.
- **iOS:** derselbe Umbau in Swift (CallKit) — siehe `UEBERGABE-MOBILE.md` §5.4;
  Stufe E.
- **Fallback, falls P1 (Kernprobe) wider Erwarten hakt:** Regler-Kopplung —
  solange `voiceActive`, Medien-Regler live an den Anruf-Regler spiegeln
  (Symptom-Überbrückung: HUD bleibt „Medien", Kopplung systemweit, betrifft
  Spotify & Co.). Kein sauberer Weg, aber Tage statt Wochen.

## Verweise

- `docs/UEBERGABE-MOBILE.md` — allgemeine Mobile-Übergabe (2026-09-06)
- `mobile/android/app/src/main/java/com/howispulse/app/SpeakerphoneRouter.java`
  — Routing-Maschinerie + ausführliche Randnotizen zu allen Feldbefunden
- `web/src/lib/platform/audioRoute.ts` — Bridge-Webseite + Diagnose-Snapshot
- `web/src/lib/voice/livekit.svelte.ts` — Voice-Fassade (Join-Reihenfolge,
  Rückbau-Liste, Token-Flow)
- `web/src/lib/voice/audioElements.ts` — der Mobile-`<audio>`-Pfad und warum
