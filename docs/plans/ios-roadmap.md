# iOS-Roadmap

**Stand:** 2026-10-08 · **Quelle:** fünf Scans am 2026-10-06 (3 Code-Sweeps, 1 empirischer
Mobil-Durchlauf als `dev` im Handy-Viewport, 1 Detail-Verifikation), seither gegen den Baum
fortgeschrieben — jeder Haken unten ist am Code geprüft, nicht aus einer Commit-Überschrift
geschlossen. Basis-Zweig: `feat/ios`.

> **Pflege-Regel.** Diese Liste war am 2026-10-08 an vier Stellen falsch: 17, 19 und 20a
> waren gebaut, standen aber als offen, und 23 war halb gebaut und sah ganz offen aus.
> Gegen eine Liste zu arbeiten, die den Stand nicht kennt, kostet mehr als das Nachtragen.
> **Wer einen Punkt erledigt, hakt ihn im selben Commit hier ab** — und wer einen Punkt
> HALB erledigt, schreibt hin, welche Hälfte fehlt.

**Zielbild:** Die iOS-App fühlt sich nativ an. Der Kern bleibt eine Web-Codebasis für alle
Plattformen; die Ränder (Tastatur, Audio, Push, Teilen, Mediensteuerung) sind konsequent
nativ verdrahtet — das moderne Hybrid-Modell.

---

## Festlegungen (Eigentümer, 2026-10-06)

1. **Mobile hat keine Sicherung.** Kein BYO-Cloud-Anschluss, kein OS-Backup. Das Handy ist
   Alltagsgerät; die Kopplung per QR ist der einzige Übernahmeweg.
   *Dokumentierter Trade-off:* Handy verloren und nie mit einem Desktop gekoppelt
   ⇒ lokaler Verlauf dieses Geräts ist unwiederbringlich (wie WhatsApp vor dem
   iCloud-Backup-Zeitalter).
2. **Desktop-Sicherung bleibt, verschlankt:** lokaler Sync-Ordner + Nextcloud (App-Passwort).
   **Dropbox und Google Drive werden eingestellt** (neue Verbindungen sperren, bestehende
   auslaufen lassen). Damit stirbt OAuth produktweit — die OAuth-Apps werden nie wieder
   gebraucht, auf keiner Plattform.
3. **Kein OAuth in den Hüllen** — der geplante native-OAuth-Bau („N1") ist gestrichen, nicht
   verschoben.
4. **Vor jedem Store-/Release-Build (Pflicht):** `capacitor.config.json` zurück auf
   `https://howispulse.com` / `cleartext: false`, Privacy Manifest + Local-Network-Key drin,
   mkcert-Zertifikat entfernt.
5. Anmelden ohne Kopplung bleibt möglich (Login = neues Geräte-Schlüsselpaar, Zukunft kommt
   an); die Kopplung transportiert die Vergangenheit — E2E-Schlüssel sind bewusst nicht aus
   dem Passwort ableitbar.
6. App-Icon-Dark-/Tinted-Varianten bauen wir bewusst NICHT (E1.11-Ergebnis): iOS 18 leitet
   beide automatisch aus dem einzelnen 1024-px-Icon ab, solange keine Dark-Appearance im
   Asset-Catalog liegt. Erst handanfassen, wenn die Ableitung optisch nicht trägt.

## Release-Checkliste iOS (vor jedem Store-/TestFlight-Build)

**Das Prüfbare davon läuft als Skript: `bash scripts/ios-release-check.sh`.**
Es prüft Punkt 1, 2 (Plugin-Liste, aus dem Quellcode abgeleitet), 3 und 4.
Die Handgriffe darunter bleiben Handarbeit.

1. `mobile/capacitor.config.json`: `server.url = https://howispulse.com/app`,
   `cleartext: false` — keine Dev-URL im Baum (Prüfung: `git diff` leer auf der Datei).
2. `npx cap sync ios` + Release-Build in Xcode (Debug-Flag `CAPACITOR_DEBUG` prüfen).
   **Danach den Hand-Patch erneut setzen**: `cap sync` erzeugt
   `App/App/capacitor.config.json` neu und kennt dabei nur die npm-Plugins —
   die EIGENEN Swift-Plugins fallen aus `packageClassList` heraus. Fehlen sie,
   baut alles durch, und erst am Gerät merkt man, dass sie nichts tun.
   **Welche es sind, steht hier bewusst NICHT mehr**: hier stand „es sind
   zwei: `AudioSessionPlugin` und `ReviewPlugin`", während vier im Baum lagen
   (2026-10-08). `scripts/ios-release-check.sh` leitet die Liste aus dem
   Quellcode ab und kann deshalb nicht veralten — gegen eine Aufzählung in
   Prosa hilft keine Sorgfalt, nur ihre Abschaffung.
   **Achtung, der Patch reist nicht mit:** die erzeugte Datei ist
   gitignored. Auf einer frischen Maschine ist die Liste also IMMER
   unvollständig, auch ohne `cap sync`. (Sauberer wäre, die Liste in
   `mobile/capacitor.config.json` zu führen und zu prüfen, ob `cap sync` sie
   stehen lässt — ungetestet, deshalb steht hier weiter der Handgriff.)
3. Privacy Manifest im Bundle: `App.app/PrivacyInfo.xcprivacy` vorhanden (Build-Produkt).
4. `web/.cert/` (mkcert) ist gitignored und landet nie im Bundle — die Hülle lädt remote.
5. Gerätelauf: Tastatur (Composer sichtbar), Zoom (Suche/Felder zoomen nicht), Theme-Wechsel
   (Statustext lesbar), Share-Sheet („In Dateien sichern"), Haptik-Spürbarkeit, Privacy-Screen
   im App-Umschalter, Self-Host-Server im Heimnetz erreichbar (Local-Network-Dialog kommt).
6. Version + Build-Nummer im Target hochsetzen; Upload über Xcode-Organizer (TestFlight).

### Bau und Installation von der Kommandozeile (2026-10-08 so gefahren)

    cd mobile/ios/App
    xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
      -destination 'id=<UDID>' -derivedDataPath build-device \
      -allowProvisioningUpdates DEVELOPMENT_TEAM=6FRUC2UST8 CODE_SIGN_STYLE=Automatic build
    xcrun devicectl device install app --device <COREDEVICE-ID> \
      build-device/Build/Products/Debug-iphoneos/App.app

**Zwei Stolpersteine, beide haben je einen Anlauf gekostet:**
1. **`DEVELOPMENT_TEAM` steht nirgends im Projekt.** Ohne die Zuweisung auf
   der Kommandozeile bricht der Bau mit „Signing for 'App' requires a
   development team" ab — in Xcode wählt man es von Hand. Für die
   CI-Lane (Punkt 46) muss es ins Projekt oder in eine `xcconfig`.
2. **`devicectl` und `xcodebuild` führen VERSCHIEDENE Gerätenummern.**
   `xcrun devicectl list devices` liefert die CoreDevice-Kennung (für
   `install`), `xcrun xctrace list devices` die UDID (für `-destination`).
   Die eine in die andere Stelle gesetzt gibt „Unable to find a device
   matching the provided destination specifier" — mit einer Liste, in der
   nur Simulatoren stehen, was in die Irre führt.

**Und eine Prüf-Falle:** Das gebaute Binary trägt KEINE Symboltabelle.
`strings`/`nm` finden darin weder die eigenen Plugins noch `AppDelegate` —
das beweist nichts. Ob eine Quelldatei wirklich übersetzt wurde, zeigt
`build-device/Build/Intermediates.noindex/App.build/.../Objects-normal/arm64/<Name>.o`.

## UI-Tests (XCUITest, seit 2026-10-06)

`mobile/ios/App/AppUITests/UITests.swift` — kompletter Sendefluss (Anmeldung
erkannt → Freunde → Chat → Composer → Senden → Bubble-Verifikation) als
Regressionsschutz. Lauf:

    cd mobile/ios/App && xcodebuild test -project App.xcodeproj \
      -scheme AppUITests \
      -destination 'platform=iOS Simulator,id=<SIMULATOR-ID>' \
      -derivedDataPath build

Simulator-ID: `xcrun simctl list devices booted`. Neues Element bauen →
Accessibility-Baum scannen (Temp-Test mit `print(app.debugDescription)`)
und Queries daraus ableiten, nie Koordinaten.

## Abgeschlossen (Fundament, 2026-10-06)

- Full-Bleed + Safe-Areas: `contentInset: never`, AppDelegate injiziert die nativen Insets
  als `--safe-area-inset-*` (Document-Start-UserScript + sofortiger Aufruf) — kein weißer
  Balken, kein System-Hintergrund, in beiden Themes randfüllend.
- Root-Scroll aus: `ios.scrollEnabled: false` + `overscroll-behavior: none` am Root.
- HTTPS-Dev über mkcert (Simulator-Trust + Geräte-Profil), Secure Context ⇒ E2E/Gerätekennung
  am Gerät lauffähig; „keine Gerätekennung" behoben.
- DB konsolidiert: chat `0099`, auth `0054`; Reparatur-Rezept in AGENTS.md.
- Composer 16 px auf Touch (Auto-Zoom-Fix, d030569d).
- Testdaten: `scripts/dev-testdaten.mjs` — 5 User, paarweise befreundet, ~66 Nachrichten.
  **Vite-HTTPS-Hinweis:** Dev-Server braucht `VITE_HTTPS_CERT`/`VITE_HTTPS_KEY`
  (`web/.cert/`), sonst lädt die Hülle ins Leere.

Verifikations-Legende: **Sim** = Simulator genügt (ich selbstständig) · **Gerät** = Abnahme
am iPhone nötig (ich baue vor) · **Portal** = braucht Michaels Zugänge (Apple/Firebase/Server).

**Was am angeschlossenen iPhone OHNE Mithilfe geht** (geprüft 2026-10-08, iPhone 16 Pro
am Kabel): installieren, starten **mit Konsole** — `xcrun devicectl device process launch
--console --terminate-existing --device <id> com.howispulse.app` —, Darwin-Mitteilungen
senden, Dateien kopieren, neu starten, sysdiagnose. Die Konsole zeigt den
Capacitor-Brückenverkehr (`To Native -> …` / `TO JS …`) und damit, OB ein Plugin gerufen
wird und was es antwortet; damit lässt sich „ist der Code überhaupt angeschlossen?"
beantworten, ohne jemanden zu fragen. **Achtung: sie zeigt auch den FCM-Token im Klartext**
— Mitschnitte nicht aufbewahren.

**Was NICHT geht:** den Bildschirm sehen, tippen oder wischen, und **drehen**:
`devicectl device orientation` existiert, antwortet auf diesem Gerät aber „capability not
supported" (am 2026-10-08 aus der Hilfe geschlossen und am Fehlschlag korrigiert). Alles,
was Aussehen oder Gefühl betrifft, bleibt echte Abnahme.

---

## Etappe 1 — Kerngefühl (100 % Sim ⇒ selbstständig)

**Offen sind hier nur noch 8 und 14.** Die anderen zwölf waren am 2026-10-08
gebaut, die Tabelle sagte aber weiter „fehlt" — nachgezogen nach einer Prüfung
gegen den Code, Beleg steht je Zeile. Dieselbe Fehlerklasse wie der
„noch an nichts angeschlossen"-Absatz in `CLAUDE.md`: eine Statusangabe, die
beim Bauen nicht mitgezogen wird, kostet später eine Doppelprüfung.

| # | Punkt | Ist → Ziel | Aufw. | Verifikation |
|---|---|---|---|---|
| 1 | Anhänge speichern/teilen — **FERTIG, am 2026-10-08 am Code nachgeprüft:** `navigator.share` ist in `web/src/lib` im Einsatz. Die Zeile stand hier noch auf dem Ausgangszustand | `<a download>`-Trick (4 Stellen: Anhang-Karte, Medienübersicht, Medienarchiv, Lightbox) → gemeinsame Funktion: `navigator.share` mit Datei wo verfügbar, sonst Anker | S | Sim |
| 2 | Tastatur — **FERTIG, am 2026-10-08 am Code nachgeprüft:** `@capacitor/keyboard` + `resize: native` in der Capacitor-Konfiguration. Die Zeile stand hier noch auf dem Ausgangszustand | `@capacitor/keyboard` fehlt; Composer läuft hinter der Tastatur → Plugin + `resize: native` | M | Sim (Software-Tastatur, Hardware-KB abschaltbar) + Gerät |
| 3 | Zoom-Falle — **FERTIG, am 2026-10-08 am Code nachgeprüft:** die Eingabefelder am Handy stehen auf `text-base` (16 px). Die Zeile stand hier noch auf dem Ausgangszustand | Chats-Suche (14 px gemessen), Gruppenname, Kamera-Beizeile sind `text-sm` → 16 px auf Touch (Muster wie Composer) | S | Sim/Playwright messbar |
| 4 | StatusBar-Theme — **FERTIG, am 2026-10-08 am Code nachgeprüft:** StatusBar-Anbindung liegt in `web/src/lib/platform`. Die Zeile stand hier noch auf dem Ausgangszustand | Kein Style-Wechsel; dunkle Uhr auf dunklem Glas → StatusBar-Style folgt App-Theme (Web ruft nativ beim Theme-Wechsel) | S | Sim (appearance dark) |
| 5 | Haptik — **FERTIG, am 2026-10-08 am Code nachgeprüft:** Haptics ist in `web/src/lib` eingebunden. Die Zeile stand hier noch auf dem Ausgangszustand | Keine → Capacitor-Haptics: Tab-Wechsel, Senden, Long-Press | S–M | Code+Build; Gefühl: Gerät |
| 6 | Externe Links — **FERTIG, am 2026-10-08 am Code nachgeprüft:** `@capacitor/browser` ist in `web/src/lib` eingebunden. Die Zeile stand hier noch auf dem Ausgangszustand | `target="_blank"` tut nichts Sinnvolles → `@capacitor/browser`-Blatt (extern falls gewollt) | S | Sim |
| 7 | Privacy-Screen (App-Umschalter) — **FERTIG, am 2026-10-08 am Code nachgeprüft:** `privacySchutz` im `AppDelegate` (nativ, nicht per CSS — s. Begründung dort). Die Zeile stand hier noch auf dem Ausgangszustand | Chat-Vorschau im Multitasking sichtbar → Blur/Deckblatt bei `scenePhase` inaktiv | S | Sim |
| 8 | App-Icon + Splash — **ENTFÄLLT GRÖSSTENTEILS, und das stand schon im eigenen Dokument:** Festlegung 6 (oben) sagt ausdrücklich, dass Dark-/Tinted-Varianten NICHT gebaut werden — iOS 18 leitet beide aus dem 1024-px-Icon ab, solange keine Dark-Appearance im Asset-Catalog liegt. Diese Tabellenzeile widersprach der Festlegung, bis es am 2026-10-08 auffiel. Offen bleibt nur die Splash-Politur, und die ist Geschmack, kein Mangel | Basis vorhanden → Dark-/Tinted-Icon-Varianten (iOS 18), Splash-Retina-Politur | S | Sim |
| 9 | **Privacy Manifest** (`PrivacyInfo.xcprivacy`) — **FERTIG, am 2026-10-08 am Code nachgeprüft:** `mobile/ios/App/App/PrivacyInfo.xcprivacy` liegt vor. Die Zeile stand hier noch auf dem Ausgangszustand | fehlt — App-Store-Pflicht | S | Build |
| 10 | **`NSLocalNetworkUsageDescription`** — **FERTIG, am 2026-10-08 am Code nachgeprüft:** `NSLocalNetworkUsageDescription` steht in der `Info.plist`. Die Zeile stand hier noch auf dem Ausgangszustand | fehlt — Self-Host im Heimnetz wird still blockiert | S | Build |
| 11 | Deployment-Target — **FERTIG, am 2026-10-08 am Code nachgeprüft:** `IPHONEOS_DEPLOYMENT_TARGET = 16.1` im Xcode-Projekt. Die Zeile stand hier noch auf dem Ausgangszustand | iOS 15.0 → 16.1 min. (Live Activities), Feature-Gating für 17+ | S | Build+Sim |
| 12 | `InfoPlist.strings` (en) — **FERTIG, am 2026-10-08 am Code nachgeprüft:** `en.lproj/InfoPlist.strings` liegt vor. Die Zeile stand hier noch auf dem Ausgangszustand | Berechtigungstexte nur deutsch, App liefert de+en → en.lproj | S | Sim |
| 13 | `archiv_schrank_secret` im Dev-Env — **FERTIG, am 2026-10-08 am Code nachgeprüft:** das Secret wird in `scripts/` gesetzt. Die Zeile stand hier noch auf dem Ausgangszustand | fehlt (PUT archiv-schluessel → 503) → dev-up setzt lokales Secret; Prod-Config-Check eintragen | S | Sim/Log |
| 14 | Release-Checkliste — **FERTIG 2026-10-08:** `scripts/ios-release-check.sh`. **Der eigentliche Grund für ein Skript statt Prosa:** die Liste unten nannte ZWEI eigene Swift-Plugins, während vier im Baum lagen — die beiden fehlenden hätte ein `cap sync` lautlos aus `packageClassList` geworfen, alles baut durch, und erst am Gerät fällt auf, dass sie nichts tun. Das Skript LEITET die Liste deshalb aus dem Quellcode ab (jede Datei mit `CAPBridgedPlugin`), statt sie zu behaupten; eine neue Swift-Datei wird automatisch mitgeprüft. **Bewusst NICHT in `gate.sh`:** die geprüfte `mobile/capacitor.config.json` steht im Alltag absichtlich auf einer Dev-URL, ein Alltags-Gate wäre dauerhaft rot und damit wirkungslos | Festlegung 4 als Datei/CI-Gate | S | Prozess |

## Etappe 2 — Erreichbarkeit

| # | Punkt | Ist → Ziel | Aufw. | Verifikation |
|---|---|---|---|---|
| 15 | Push-Basis PM/Erwähnung — **FERTIG 2026-10-06, am Gerät verifiziert**: APNs-Keys (Sandbox&Production-Key D4X4VN6JF2 in Firebase Dev+Prod-Zeile), Entitlement, FCM-Weg für iOS-Hülle geöffnet, Token-Registrierung + Banner am Gerät bestätigt. Notwendig dafür war zusätzlich: FIREBASE_SERVICE_ACCOUNT_KEY am Gateway (dev-up) und Garage/MinIO-Port-Frieden im Dev-Stack | ✅ | Gerät ✓ |
| 16 | Universal Links — **GEBAUT 2026-10-08, braucht Neubau + Deploy.** Beansprucht sind NUR Chat-Pfade (`/app/@me/*`, `/app/rooms/*`, `/app/guilds/*`, Eigentümer-Entscheid) — die übrige Web-App bleibt im Browser erreichbar. Team ID `6FRUC2UST8` aus dem Provisioning-Profil. Datei liegt in `web/static/.well-known/`; **der eigene nginx-Block ist Pflicht**, weil sie absichtlich keine Dateiendung trägt und nginx ihr sonst nicht `application/json` gibt — iOS holt sie dann ab, verwirft sie still, und nichts funktioniert ohne Fehlermeldung. Klient-Seite: `platform/universalLinks.ts` über `platform/tiefenlink.ts` (geprüft, 7 Tests: fremde Herkunft, http, Pfade ausserhalb `/app`, `/appetit`-Präfixfalle). **Offen: Entitlement wirkt erst nach nativem Neubau, AASA erst nach Web-Deploy** | M | Gerät + Deploy |
| 17 | Icon-Badge — **FERTIG 2026-10-08, am Gerät verifiziert.** Gezählt werden ungelesene NACHRICHTEN der privaten Gespräche. Die Zahl reist im Push mit (`aps.badge`), weil die JS-Engine im Hintergrund eingefroren ist; der Server führt sie als Fortschreibung je Konto (`badgezaehler.py`), der wache Klient korrigiert sie über `POST /fcm/badge`. Zwei Fallen, beide am Gerät gefunden: der Klient darf seine 0 erst melden, wenn der Postfach-Abholweg durch ist (sonst löscht „weiss ich nicht" den richtigen Stand), und `latestByChannel` muss aus dem `ready`-Rahmen gesät werden (sonst ist `isUnread` beim Start immer false und die App zeigt nirgends eine Marke) | ✅ | Gerät ✓ |
| 18 | Mitteilungs-Aktion „Antworten" — **NEU ZUGESCHNITTEN 2026-10-08 (Eigentümer).** Der ursprüngliche Punkt (Bild im Banner, entschlüsselte Vorschau) ist mit E2E-DMs **grundsätzlich nicht baubar**: eine Notification Service Extension ist ein eigener Prozess, kommt nicht an die IndexedDB der WebView, und das Geräte-Geheimnis ist `extractable: false`. Sie könnte weder Bild noch Text zeigen. Gebaut ist, was ohne Entschlüsselung geht: `UNTextInputNotificationAction` im AppDelegate (Kategorie `dm`, wortgleich mit `fcm.py::DM_KATEGORIE`) — der im Banner getippte Text wird als ENTWURF hinterlegt und im aufgehenden Chat gesendet, nicht im Ereignis-Handler. Dazu der Anhang-Hinweis: „Hat dir einen Anhang geschickt" statt „Neue Nachricht", wenn Bezugszeilen vorliegen (der Server weiss das, den Inhalt nie). **Eine Hintergrund-Aktion wie „Gelesen" braucht erst Punkt 35** — ohne Token in der Keychain erreicht nativer Code den Server nicht. **Am Gerät 2026-10-08:** Bau, Installation und Start verifiziert (iPhone 16 Pro), Anhang-Hinweis im Banner bestätigt. Die Antworten-Aktion ist registriert und ausgeliefert, eine ausdrückliche Gegenprobe am Banner steht noch aus | M | Gerät (teilweise ✓) |
| 19 | Zeitkritische Pushs + Sounds — **FERTIG**: `apns-interruption-level: time-sensitive` + eigener Sound `pulse-push.caf` (im Bundle, Copy-Resources), Entitlement `com.apple.developer.usernotifications.time-sensitive` | ✅ | Gerät ✓ |
| 20a | **Server: Stale-WS-Erkennung** — **FERTIG**: `ConnectionManager.stale_socket_reaper_loop` (Schwelle 95 s gegen den 25-s-Client-Ping), `user_socket_count` zählt nur frische Sockets. Im Hintergrund suspendierte Apps hielten sonst halboffene WebSockets, die der Gateway Minuten als online zählte und dabei Pushes unterdrückte | ✅ | Server |
| 20b | Review-Prompt — **GEBAUT 2026-10-08, braucht nativen Neubau.** Eigenes Swift-Plugin (`ReviewPlugin.swift`) statt Fremdpaket (Eigentümer-Entscheid): der Inhalt ist ein Systemaufruf. Gefragt wird NICHT nach jedem Senden, sondern nach 20 gesendeten Nachrichten und danach nie wieder von selbst (`platform/bewertungRegel.ts`, geprüft) — iOS zeigt die Frage höchstens dreimal im Jahr und sagt nie, ob sie erschien; jeder Aufruf verbraucht also blind ein knappes Kontingent, und bei jedem Senden zu fragen verschiesst es genau dann, wenn der Nutzer die App noch nicht kennt. **Die Oberfläche darf aus dem Aufruf nichts schliessen** — ein „Danke für deine Bewertung" danach wäre eine Lüge | S | Gerät |

## Etappe 3 — Audio nativ

| # | Punkt | Ist → Ziel | Aufw. | Verifikation |
|---|---|---|---|---|
| 21 | Audio-Session — **GEBAUT, Gerätetest der Sprachseite offen**: `AudioSessionPlugin.swift` (`.playAndRecord`+`.voiceChat`), verdrahtet in `livekit.svelte.ts` (Betreten/Verlassen/Teardown). Der `.playback`-Zweig gehört zu 23 und hängt noch | M | Gerät |
| 22 | Echo-Unterdrückung — **kein Einbau nötig, es fehlt die MESSUNG.** Beides ist schon da: System-AEC/-Rauschunterdrückung hängen am `.voiceChat`-Modus (seit Punkt 21, kein eigener Schalter), und RNNoise ist über `settings.audio.noiseSuppression` abschaltbar. Offen ist nur, ob die Kombination besser, schlechter oder gleich ist — und ob RNNoise auf dem Telefon Rechenzeit ohne Gegenwert kostet. Vorgabe bleibt unverändert, bis Zahlen vorliegen. Anleitung: [2026-10-08-ios-echo-messanleitung.md](../2026-10-08-ios-echo-messanleitung.md) | S | Gerät (Messung) |
| 23 | Ton im Hintergrund/gesperrt — **GEBAUT 2026-10-08, Gerätetest offen.** `UIBackgroundModes: audio` stand schon; neu ist der Koordinator `platform/iosTon.ts` mit der geprüften Entscheidung in `tonModus.ts`. Vorher sprachen Sprachkanal und Stream-Ton unabhängig mit dem Plugin, `iosPlaybackModus` hatte gar keinen Aufrufer, und `setVoiceActive(false)` deaktivierte die prozessweite Session — Sprachkanal verlassen riss laufenden Stream-Ton mit. Jetzt gewinnt Voice (trägt Wiedergabe mit), und die letzte endende Wiedergabe gibt die Session frei. Angebunden: HQ-Zuschauer und Gast-Kacheln. **Rein im TS gelöst — kein nativer Neubau nötig.** Am Gerät zu prüfen: Display sperren im Sprachkanal, und Sprachkanal verlassen während ein Stream läuft | M | Gerät |
| 24 | Bluetooth/Auto/Headset — **GEBAUT 2026-10-08, Gerätetest offen.** Session erlaubt jetzt ausdrücklich Bluetooth (`allowBluetooth` + `allowBluetoothA2DP`), Wegwechsel werden beobachtet (`routeGewechselt`), und Lautsprecher/Hörmuschel sind in der bestehenden Sprachleiste auch auf iOS wählbar. **Bewusst KEINE eigene Geräteliste in der App:** auf iOS wählt man das Ausgabegerät im System (Kontrollzentrum/AirPlay) — eine App-eigene Liste wäre eine zweite, schlechtere Bedienung derselben Sache. Der native Knopf dafür ist Punkt 30; damit fallen 24 und 30 auf iOS zusammen | M | Gerät |
| 25 | Lockscreen-/Control-Center-Steuerung — **GEBAUT 2026-10-08, Gerätetest offen.** `MPNowPlayingInfoCenter` zeigt „Übertragung von <Name>", `MPRemoteCommandCenter` trägt zwei Knöpfe. **Was „Pause" bei einem Live-Strom heisst, ist eine Entscheidung:** anhalten kann man ihn nicht, und ihn vom Sperrbildschirm aus zu BEENDEN wäre zu grob — ein Fehlgriff risse die Übertragung weg. Pause heisst hier stumm, Wiedergabe wieder laut; nicht-zerstörend und sofort umkehrbar. Mindestens ein aktiver Befehl ist nötig, sonst blendet iOS die Anzeige ganz aus; Titelsprünge sind abgeschaltet, damit keine toten Knöpfe erscheinen. Anzeige hängt an der ERSTEN und LETZTEN Kachel, nicht an jeder | M | Gerät |
| 26 | GSM-Unterbrechung — **GEBAUT 2026-10-08, Gerätetest offen.** `interruptionNotification` im Plugin, ausgewertet im Koordinator (`platform/iosTon.ts`). **Der nicht offensichtliche Teil:** iOS schaltet die Session zu Beginn selbst ab, danach ist der Sprachkanal stumm, obwohl die Verbindung steht — und der Koordinator hätte nichts getan, weil das Ziel ja weiter `voice` ist. Er setzt deshalb seinen Merker zurück, sonst wäre der ganze Beobachter wirkungslos. `shouldResume` wird bewusst nicht verlangt: iOS setzt es nicht zuverlässig | S–M | Gerät |

## Etappe 4 — Media-Show

| # | Punkt | Ist → Ziel | Aufw. | Verifikation |
|---|---|---|---|---|
| 27 | Stream quer/Vollbild — **GEBAUT 2026-10-08, Gerätetest offen.** Zwei Befunde statt einem. **(a) Gedreht wurde nicht, weil die `Info.plist` nur Portrait DEKLARIERTE** — iOS stellt das Vollbild eines `<video>` ausschliesslich in deklarierten Lagen dar, da hilft kein Plugin und kein Webcode. Die Plist erlaubt dem iPhone jetzt alle drei Lagen (kopfüber bewusst nicht), und der Riegel sitzt zur Laufzeit im `AppDelegate` (`supportedInterfaceOrientationsFor`), gesteuert von `OrientationPlugin.swift` — gleicher JS-Name und gleiche Signatur wie das Android-Pendant, `orientation.ts` verliert dafür seinen `isCapacitorAndroid()`-Riegel. Querformat gilt damit wie auf Android NUR mit angedocktem Stream. iOS lässt die erlaubten Lagen nur abfragen, nicht setzen: deshalb Schalter + `setNeedsUpdateOfSupportedInterfaceOrientations`, und beim Zurücknehmen zusätzlich `requestGeometryUpdate` — ohne das bliebe die Oberfläche quer stehen, solange man das Gerät quer hält. **(b) Das Vollbild lief am iPhone über Apples SYSTEMPLAYER** (`webkitEnterFullscreen`, der Rückfall in `stream/fullscreen.ts`), und das war der eigentliche Fehler: der Player ersetzt unsere Oberfläche mitsamt dem Lautstärkeregler der Kachel. Der wirkt auf den Web-Audio-Graphen des Streams (das `<video>` ist stumm, `hqStreamManager`) und ist damit von der Sprachkanal-Lautstärke GETRENNT — der Systemplayer kennt nur die Geräte-Lautstärke, die für Voice mitgilt. Folge im Betrieb: ein lauter Stream übertönt die Leute im Sprachkanal. Jetzt baut `TileShell` ihr Vollbild dort selbst (`eigenesVollbildNoetig` prüft die FÄHIGKEIT, nicht die Plattform); der WebKit-Weg bleibt nur noch für ein ABGELEHNTES `requestFullscreen`. Nebenwirkung, geprüft: `fixed inset-0` im `fixed`-Rahmen des Hintergrund-Hosts wird NICHT geclippt (`frameStyle` setzt nur top/left/width/height, kein `transform`) — nachgemessen, weil genau diese Annahme hier beim Profil-Blatt schon einmal falsch war. Mitgezogen: die Safe-Area-Einzüge werden nach jeder Drehung neu gelesen; sie waren einmalig, weil die Hülle nicht drehen konnte. Am Gerät zu prüfen: quer halten mit offenem Stream, Lautstärke im Vollbild getrennt von Voice, und zurück im Hochformat dreht es selbst zurück | M | Sim+Gerät |
| 28 | Live Activity / Dynamic Island | — → ActivityKit: „Im Sprachkanal X", Stream-Zuschauer; interaktive Aktionen | L | Sim (Island vorhanden) |
| 29 | Picture-in-Picture | Web-Eckfenster → echtes System-PiP über alle Apps (AVPictureInPictureController) | L | Sim+Gerät |
| 30 | AirPlay — **GEBAUT 2026-10-08, Gerätetest offen.** Eintrag „AirPlay …" im Ausgabe-Menü der Sprachleiste öffnet Apples eigene Auswahl (`airplayWaehler` im `AudioSessionPlugin`). **Der unsichtbare `AVRoutePickerView` mit programmatisch ausgelöstem Tipp ist der einzige öffentliche Weg** — es gibt keine Schnittstelle, die den Dialog direkt aufruft, und einen nativen Knopf pixelgenau über eine WebView zu legen hiesse, seine Position bei jedem Umbau der Leiste nachzupflegen. Keine private Schnittstelle: wir schicken einer öffentlichen Ansicht eine Aktion auf ihren eigenen Unterknopf. Dass dieser Unterknopf ein `UIButton` IST, ist allerdings nirgends zugesagt — **deshalb wird der Fehlschlag gemeldet statt verschluckt** und das Menü zeigt dann den Hinweis aufs Kontrollzentrum. Mitgezogen: `iosWegWechsel` hatte KEINEN Aufrufer — Punkt 24 behauptete „Wegwechsel werden beobachtet", nativ stimmte das, im Web hörte niemand zu; die Liste hing allein an `devicechange`, und ob die WKWebView das beim Verbinden von AirPods feuert, ist nicht belegt. Sichtbar wäre es nur als veraltetes Zeichen in der Leiste. Dafür ist das Ausgabe-Menü in `VoiceAusgabeMenue.svelte` herausgezogen (die Leiste lag mit 376 Zeilen über der Policy) | — → AVRoutePickerView | M | Gerät |
| 31 | Wake-Lock — **GEBAUT 2026-10-08 statt nur geprüft.** Die Frage war „greift `navigator.wakeLock` in einer WKWebView?", und sie ist jetzt gegenstandslos: `WachhaltenPlugin.swift` (`isIdleTimerDisabled`) ist in der iOS-Hülle der vorgezogene Weg. **Warum nicht erst messen:** Safari kann die Schnittstelle seit iOS 16.4, für die eingebettete WebView ist das damit nicht mitgesagt — und der Browser-Weg scheitert nicht laut, er tut nichts. Der Bildschirm ginge mitten im Zuschauen aus, und nichts sagte warum. Der Zähler bleibt im Web (`platform/wakeLock.ts`): mehrere Kacheln können gleichzeitig wach halten wollen, ein zweiter Zähler nativ wäre eine zweite Wahrheit. Electron-Brücke und iOS-Plugin haben dieselbe Form und teilen sich deshalb EINEN Zugang (`nativerSchalter`) statt eines dritten Zweiges | `navigator.wakeLock` vorhanden → Verhalten im WKWebView am Gerät prüfen, ggf. nativ ersetzen | S | Gerät |
| 32 | Lightbox Pinch-Zoom — **GEBAUT 2026-10-08, Sim-Abnahme offen.** Pinch 1–4x, Doppeltipp schaltet 1x/2x, im Zoom schiebbar, Grenzen so, dass keine leere Fläche einläuft. Rechnung importfrei und geprüft (`components/lightboxZoom.ts`, 6 Tests), Gesten über Pointer-Events (tragen Finger, Stift und Maus; `touch-action: none` ist Pflicht, sonst frisst der Browser Pinch und Wisch selbst). Keine neue Abhängigkeit. **Was die Tests NICHT abdecken: das Gefühl** — Trägheit, Fingertreue beim Pinch, Doppeltipp-Fenster. Das gehört in den Simulator | S | Sim |

## Etappe 5 — Integrität & Übernahme (angepasst: ohne OAuth)

| # | Punkt | Ist → Ziel | Aufw. | Verifikation |
|---|---|---|---|---|
| 33 | BYO-Cloud einfrieren | Dropbox/GDrive-Verbindungen → neue sperren, Mobile-Sicherungs-UI gar nicht erst zeigen, Desktop auf Sync-Ordner+Nextcloud reduzieren; Bestandsläufe dokumentieren | S–M | Sim |
| 34 | QR-Scan für Kopplung — **GEBAUT 2026-10-08, Gerätetest offen.** `QrScanPlugin.swift` (AVFoundation, `AVCaptureMetadataOutput` mit `.qr`), Knopf „Code scannen" neben dem Eingabefeld in `KopplungEinloesen.svelte`. **Die Anzeige-Seite gab es längst** — das eingerichtete Gerät zeigt den Code als QR (`kopplung/qr.ts`); gefehlt hat das Lesen, und das neue Gerät musste 20 Zeichen abtippen, in einem Alphabet, in dem man 0 und O verwechselt. Kein Fremdpaket, gleiche Begründung wie beim Bewertungs-Plugin: der Inhalt ist ein Systemaufruf. **Der gescannte Inhalt wird normalisiert und GEPRÜFT, nicht blind eingelöst** — eine Kamera liest jeden QR-Code, den man ihr hinhält, auch eine Paketverfolgung; ohne die Prüfung ginge so ein Treffer an den Server, verbrauchte eine Rate-Chance und sähe wie „Code abgelaufen" aus. Trifft es, wird sofort eingelöst (wer gescannt hat, hat seine Eingabe gemacht); trifft es nicht, landet der Rohtext im Feld, damit man SIEHT, was gelesen wurde. **Nur die iOS-Hülle, bewusst.** Der erste Entwurf gab den Knopf frei, sobald der Browser `BarcodeDetector` mitbringt — Chromium tut das, und damit Android. Nur prüft die Schnittstelle ein EINZELNES BILD und bringt keine Kamera-Ansicht mit: der Knopf wäre erschienen und hätte nichts getan. Im Browser und auf Android bleibt das Eintippen, und das ist kein Notnagel — es muss ohnehin funktionieren (Kamera verweigert, kein Licht, Code auf Papier) | Web-Scanner nutzt `BarcodeDetector` (WebKit: nein) → nativer Scanner (AVFoundation) oder sauberer Tippen-Fallback | M | Gerät |
| 35 | Tokens in Keychain — **ENTFÄLLT ALS HÄRTUNG (2026-10-08 geprüft), bleibt als VORAUSSETZUNG für Hintergrund-Aktionen.** Die Prämisse „JWTs im WebView-localStorage" stimmt nicht mehr: der Sicherheits-Audit vom 2026-09-16 hat den Refresh-Token (30 Tage) aus dem Speicher genommen — er reist im HttpOnly-Cookie `pulse_rt` (`api/storage.ts`) —, und Self-Host-Sitzungstoken liegen ausdrücklich **nur im Arbeitsspeicher** (`api/session_tokens.svelte.ts`: „In-Memory ONLY — NIEMALS persistieren"). Im `localStorage` steht noch GENAU EIN Token, der Cloud-Access mit 15 Minuten Laufzeit. **Inventar gemacht, nicht vermutet:** alle geschriebenen Schlüssel durchgesehen; `pulse.krypto.*` ist ein Web-Locks-Namensraum und kein Speicher, `pulse.direct.pin.*` ein ÖFFENTLICHER DTLS-Fingerabdruck, die Klartext-Stream-Keys unter `custom_servers` sind Tauri-Altlast und werden nicht mehr geschrieben (`stream/persistence.ts`), Geräteschlüssel und Sicherungs-DEK liegen in der IndexedDB. Nichts Langlebiges und Geheimes im `localStorage`. **Warum die Keychain für den 15-Minuten-Token nichts bringt:** die Bedrohung ist ein XSS in der entfernt geladenen Web-App, und JS muss den Token für jeden `Authorization`-Kopf lesen — ein XSS ruft dieselbe Brücke und bekommt ihn. Eine echte Grenze wäre nur, wenn NATIV die Anfragen stellt und JS den Token nie sieht; das wäre ein Umbau aller API-Aufrufe und steht in keinem Verhältnis. **Und der Hebel läge ohnehin woanders:** das wertvollste langlebige Geheimnis auf dem Gerät ist der `pulse_rt`-Cookie im Cookie-Speicher der WKWebView (30 Tage), und den schützt die Keychain nicht — ihn schützt der Dateischutz des App-Containers. **Was bleibt:** ohne eine nativ gehaltene Berechtigung erreicht Hintergrund-Code den Server nicht, und daran hängt eine Aktion wie „Gelesen" aus Punkt 18. Das wäre aber NICHT der Access-Token des Nutzers (beim Eintreffen einer Mitteilung längst abgelaufen), sondern ein eigener, eng geschnittener Geräte-Token samt Server-Route — ein Backend-Stück, das erst gebaut wird, wenn jemand die Hintergrund-Aktion wirklich will | JWTs im WebView-localStorage ([auth.svelte.ts](../../web/src/lib/stores/auth.svelte.ts)) → Keychain/Keystore für Pulse- + geerbte Cloud-Tokens | M | Sim |
| 36 | Berechtigungs-Priming — **GEBAUT 2026-10-08 für Mitteilungen und Kamera, Mikrofon bewusst NICHT, Gerätetest offen.** Der iOS-Dialog erscheint GENAU EINMAL; ein „nein" ist dauerhaft und nur in den System-Einstellungen umkehrbar. Pulse fragte die Mitteilungs-Erlaubnis **beim Start** ab (`fcm.ts`), also bevor der Nutzer die App gesehen hat — der schlechteste Augenblick, den es gibt, weil es dort keinen Grund für ein Ja gibt. Jetzt: Vorerklärung als Blatt, und gefragt wird erst nach einem Anlass (drei gesendete Nachrichten; Zähler geteilt mit der Bewertungsfrage über `eigeneSendungen.ts`, zwei Zähler auf dasselbe Ereignis wären zwei Wahrheiten). Regel geprüft in `berechtigungRegel.ts`. **Zwei Entscheidungen, die man leicht falsch trifft:** (1) Ein „später" wird nur bei MITTEILUNGEN dauerhaft gemerkt — bei Kamera und Mikrofon ist „später" das Abbrechen der Handlung, nicht das Ablehnen der Erklärung; würde man es merken, käme beim nächsten Öffnen der System-Dialog ohne Erklärung, also genau das, was der Punkt verhindern soll. (2) Für Mikrofon und Kamera gibt es in einer WKWebView **keine Auskunft über den Erlaubnis-Stand** (`navigator.permissions.query` kennt die Namen dort nicht verlässlich). Der Stand wird deshalb aus dem tatsächlichen AUSGANG gemerkt: `getUserMedia` geklappt = erteilt, `NotAllowedError` = verweigert, jeder andere Fehler sagt über die Erlaubnis nichts und lässt den Stand unberührt. **Warum das Mikrofon KEINE Vorerklärung bekommt:** der naheliegende Ort wäre vor `voice.connect`, aber dort steht seit langem der Satz „connect() must run from this user gesture so the browser allows the AudioContext to start" — ein `await` auf das Blatt bricht die Gesten-Kette und der Ton dürfte danach nicht starten. Am 2026-10-08 so gebaut und am Satz darüber wieder erkannt; der Grund steht jetzt dort. Das Mikrofon behält die Erklärung des Systems mit unserem Text aus `NSMicrophoneUsageDescription`. Die Kamera hat das Problem nicht (sie startet aus einem Effekt, nicht aus der Geste) und ist verdrahtet. **Ein Eigenfehler, im Vereinfachungs-Lauf gefunden:** „Später" im Kamera-Blatt liess die Lade-Fläche stehen („Kamera startet …") — ein Endlos-Spinner ohne Ausweg, weil der Abbruchzweig nur zurückkehrte. Schliesst jetzt das Overlay | Unvorbereitete System-Dialoge → kontextuelle Vor-Erklärung (Mic/Kamera/Push) | M | Gerät |
| 37 | Offline-/Reconnect-UX — **GEBAUT 2026-10-08, Sicht-Abnahme offen.** Zwei Teile. **(a) Schnelle Rückholung** (`ws/netzwache.ts` + `wachPruefen`): der Reconnect staffelt sich bewusst bis 300 s auseinander, und das ist gegen einen abweisenden Server richtig — für ein Telefon ist es die falsche Zahl. Wer durch einen Tunnel fährt oder von WLAN auf Mobilfunk wechselt, stand danach bis zu fünf Minuten vor einer stillstehenden App. Es fehlte kein kürzerer Takt, sondern ein ANLASS: drei davon (`online`, `visibilitychange`, Capacitor `appStateChange`). **Ein offener Socket beweist dabei nichts** — nach einem Netzwechsel bleibt er oft `OPEN` und ist tot; beim Aufwachen gilt deshalb eine kurze Frist (`WS_WACH_FRIST_MS`, 5 s) statt der 90 s des Herzschlags, die absichtlich gross sind, weil Browser Zeitgeber im Hintergrund drosseln. **Der Backoff-Zähler wird NICHT zurückgesetzt** (Bughunt Runde 43): ein wiedergekehrtes Netz bekommt EINEN sofortigen Versuch, nicht eine neue Leiter. Entscheidung geprüft in `wachentscheid.ts` (7 Tests). **(b) Sichtbarer Hinweis** (`VerbindungsHinweis.svelte`, Regel in `offlinehinweis.ts`, 7 Tests): es gab bis hierher GENAU EINE Verbindungsanzeige, den farbigen Punkt in der `GuildRail` — und die ist Desktop-only. Auf Handy und Tablet blieb weiss einfach weiss. **Bewusst kein blockierendes Deckblatt**, obwohl hier „Deckblatt" stand: ein Deckel nimmt dem Nutzer, was ohne Netz weiter funktioniert (Verlauf lesen, Antwort tippen, Kanal wechseln). Drei der vier Regeln sind Zurückhaltung — kein Hinweis bei Zuständen mit eigener Anzeige (Server zu alt, gesperrt, Zweitfaktor fehlt; dort wäre „keine Verbindung" die falsche Diagnose), keiner bei einem kurzen Abriss, und `navigator.onLine === true` gilt nicht als Gegenbeweis (ein Hotelnetz ist auch „online"). **Zwei Eigenfehler auf dem Weg, beide behoben:** Ich hatte eine ZWEITE reaktive Spiegelung des Verbindungszustands gebaut, samt Melder-Mechanismus in `gateway-connection.ts` — während `server-state.svelte.ts` daneben dasselbe tut und in ihrem eigenen Kopf steht, dass keine dritte gebaut werden soll. Alles zurückgebaut; sie trägt jetzt zwei Felder mehr (`gewollt`, `seit`). Und die Geduldsuhr hing am Zustandswechsel statt am Abriss, wodurch der Streifen beim Wiederverbinden flackerte (rot → nichts → gelb) — an der Wurzel behoben statt in der Regel mit einem Gedächtnis, das einen Lese-Schreib-Zyklus erzeugt hätte | Weiß bei Netzverlust → Offline-Deckblatt, WS-Rückholung nach Netzwechsel | S–M | Sim (Vite killen) |
| 38 | Dynamic Type + VoiceOver-Basis — **GEBAUT 2026-10-08, Sicht-Abnahme offen.** **(a) Systemschrift:** eine WKWebView mit `width=device-width` schaltet die Textvergrößerung von selbst ab, und `-webkit-text-size-adjust` war nirgends gesetzt — die iOS-Einstellung wirkte in jeder Systemapp und in Safari, nur nicht hier. Der `AppDelegate` meldet die ROHE Kategorie als `data-schriftkategorie` am `<html>` (Einweg-Signal, dasselbe Rezept wie die Safe-Area-Einzüge — ein Plugin bräuchte Aufruf UND Melder, das Attribut ist beides), die Umrechnung liegt geprüft im Web (`platform/schriftskala.ts`). **Angewandt wird `-webkit-text-size-adjust`, NICHT die Wurzel-Schriftgröße:** alle Größen dieser App stehen in `rem`, eine größere Wurzel skalierte das ganze Layout mit — und dort gibt es harte Zusagen (einzeilige Sprach-Knopfreihe, 48-dp-Trefferflächen, beide begründet bzw. gemessen). **Obergrenze 160 %, und sie ist UNGEMESSEN:** iOS reicht bis AX5, etwa das Dreifache; Text, der aufs Dreifache wächst, während sein Kasten gleich bleibt, ist nicht groß, sondern abgeschnitten. Was wirklich passt, zeigt erst ein Durchgang mit eingeschalteter Großschrift am Gerät. **(b) VoiceOver-Basis:** `scripts/voiceover-namen.sh`, **im Gate** (`gate.sh`, web-Teil). Jede tippbare Fläche in `components/mobile/**` und `routes/app/**` braucht einen Namen — Text, `{m.…}` im Inhalt oder `aria-label`/`aria-labelledby`/`title`. Gefunden und behoben: drei symbolonly-Knöpfe ohne Namen (Aufnahme beenden und Senden in der Kamera, Zurück in den Kanal-Rechten) — für VoiceOver hiessen sie alle „Taste". **Bewusst kein Playwright-Test:** Playwright hängt in KEINEM Gate, eine Prüfung die nie läuft sieht aus wie eine grüne. Das Skript läuft überall in einer Sekunde; Gegenprobe gefahren (Name entfernt ⇒ rot). **Was es nicht kann:** es liest Markup, nicht den Barrierefreiheits-Baum — ein sinnloses `aria-label` besteht. Es findet „gar kein Name", nicht „schlechter Name" | WKWebView ignoriert Systemschrift → Skalierung anbinden, Basis-Labels | M | Sim (content size) |
| 39 | Kamera-Flow + Glas-Performance | Plugins da, Gerätetest offen → Live-Abnahme Foto/Video/Beizeile, Scroll-Flüssigkeit | S | Gerät |

## Etappe 6 — Anrufe komplett

| # | Punkt | Ist → Ziel | Aufw. | Verifikation |
|---|---|---|---|---|
| 40 | CallKit + VoIP-Push | Klingeln nur per WS ([anruf.svelte.ts](../../web/src/lib/anrufe/anruf.svelte.ts)) — Hintergrund tot → CallKit-Screen, Sperrbildschirm, VoIP-Push (iOS erzwingt CallKit) | XL | Portal+Gerät |

## Etappe 7 — Ausbau

| # | Punkt | Aufw. |
|---|---|---|
| 41 | Share-Empfang (Safari/Fotos → Pulse, Share-Extension in Swift) | M–L |
| 42 | Face-ID-App-Lock | M |
| 43 | iPad: Split-View/Sides nutzen (`--safe-area-inset-left/right` fehlen) | M |
| 44 | Quick Actions (Home-Screen-Long-Press) | S |
| 45 | Widgets + App Intents (ungelesene PMs, „sende X …") | L |
| 46 | TestFlight-Distribution + iOS-CI-Lane (GH Actions → xcodebuild → upload) | M |
| 47 | Screen teilen mobil (ReplayKit) — optional, Ansehen geht schon | L |
| 48 | CarPlay (Sprachräume) — Vision | XL |

## Portal-/Zugangs-Abhängigkeiten (braucht Michael)

- APNs-Auth-Key (.p8) im Apple-Developer-Portal erzeugen und in der Firebase-Konsole hinterlegen (#15, #40).
- App Store Connect: Bundle-ID freischalten, TestFlight (#46).
- `apple-app-site-association` auf howispulse.com deployen (#16).
- OAuth-Apps Dropbox/Google: nach Auslauf von #33 löschen (#2 der Festlegungen).

## Fahrplan-Logik

Etappe 1 ist vollständig selbstständig (Sim) — danach stehen beide Geräte zur Abnahme.
Etappe 2+6 hängen am Portal-Key; Etappe 3/4 mischen Sim-Bau mit Geräte-Abnahme; Etappe 5
trägt die neuen Festlegungen. Reihenfolge innerhalb einer Etappe = Reihenfolge der Tabelle.
