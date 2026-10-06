# iOS-Roadmap

**Stand:** 2026-10-06 · **Quelle:** fünf Scans am selben Tag (3 Code-Sweeps, 1 empirischer
Mobil-Durchlauf als `dev` im Handy-Viewport, 1 Detail-Verifikation) — jeder Befund ist gegen
den Baum verifiziert, nichts geraten. Basis-Zweig: `feat/ios`.

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

1. `mobile/capacitor.config.json`: `server.url = https://howispulse.com/app`,
   `cleartext: false` — keine Dev-URL im Baum (Prüfung: `git diff` leer auf der Datei).
2. `npx cap sync ios` + Release-Build in Xcode (Debug-Flag `CAPACITOR_DEBUG` prüfen).
3. Privacy Manifest im Bundle: `App.app/PrivacyInfo.xcprivacy` vorhanden (Build-Produkt).
4. `web/.cert/` (mkcert) ist gitignored und landet nie im Bundle — die Hülle lädt remote.
5. Gerätelauf: Tastatur (Composer sichtbar), Zoom (Suche/Felder zoomen nicht), Theme-Wechsel
   (Statustext lesbar), Share-Sheet („In Dateien sichern"), Haptik-Spürbarkeit, Privacy-Screen
   im App-Umschalter, Self-Host-Server im Heimnetz erreichbar (Local-Network-Dialog kommt).
6. Version + Build-Nummer im Target hochsetzen; Upload über Xcode-Organizer (TestFlight).

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

---

## Etappe 1 — Kerngefühl (100 % Sim ⇒ selbstständig)

| # | Punkt | Ist → Ziel | Aufw. | Verifikation |
|---|---|---|---|---|
| 1 | Anhänge speichern/teilen | `<a download>`-Trick (4 Stellen: Anhang-Karte, Medienübersicht, Medienarchiv, Lightbox) → gemeinsame Funktion: `navigator.share` mit Datei wo verfügbar, sonst Anker | S | Sim |
| 2 | Tastatur | `@capacitor/keyboard` fehlt; Composer läuft hinter der Tastatur → Plugin + `resize: native` | M | Sim (Software-Tastatur, Hardware-KB abschaltbar) + Gerät |
| 3 | Zoom-Falle | Chats-Suche (14 px gemessen), Gruppenname, Kamera-Beizeile sind `text-sm` → 16 px auf Touch (Muster wie Composer) | S | Sim/Playwright messbar |
| 4 | StatusBar-Theme | Kein Style-Wechsel; dunkle Uhr auf dunklem Glas → StatusBar-Style folgt App-Theme (Web ruft nativ beim Theme-Wechsel) | S | Sim (appearance dark) |
| 5 | Haptik | Keine → Capacitor-Haptics: Tab-Wechsel, Senden, Long-Press | S–M | Code+Build; Gefühl: Gerät |
| 6 | Externe Links | `target="_blank"` tut nichts Sinnvolles → `@capacitor/browser`-Blatt (extern falls gewollt) | S | Sim |
| 7 | Privacy-Screen (App-Umschalter) | Chat-Vorschau im Multitasking sichtbar → Blur/Deckblatt bei `scenePhase` inaktiv | S | Sim |
| 8 | App-Icon + Splash | Basis vorhanden → Dark-/Tinted-Icon-Varianten (iOS 18), Splash-Retina-Politur | S | Sim |
| 9 | **Privacy Manifest** (`PrivacyInfo.xcprivacy`) | fehlt — App-Store-Pflicht | S | Build |
| 10 | **`NSLocalNetworkUsageDescription`** | fehlt — Self-Host im Heimnetz wird still blockiert | S | Build |
| 11 | Deployment-Target | iOS 15.0 → 16.1 min. (Live Activities), Feature-Gating für 17+ | S | Build+Sim |
| 12 | `InfoPlist.strings` (en) | Berechtigungstexte nur deutsch, App liefert de+en → en.lproj | S | Sim |
| 13 | `archiv_schrank_secret` im Dev-Env | fehlt (PUT archiv-schluessel → 503) → dev-up setzt lokales Secret; Prod-Config-Check eintragen | S | Sim/Log |
| 14 | Release-Checkliste | Festlegung 4 als Datei/CI-Gate | S | Prozess |

## Etappe 2 — Erreichbarkeit

| # | Punkt | Ist → Ziel | Aufw. | Verifikation |
|---|---|---|---|---|
| 15 | Push-Basis PM/Erwähnung | FCM nur Android ([fcm.ts](../../web/src/lib/platform/fcm.ts) ruft nur Android-Plugin) → APNs-Key im Firebase, Push-Entitlement, Registrierung iOS | M | Portal + Gerät |
| 16 | Universal Links | fehlt → Entitlement + `apple-app-site-association` auf howispulse.com; Grundlage für Push-Taps | M | Portal + Gerät |
| 17 | Icon-Badge | Web-Title-Punkt → `setApplicationBadgeNumber` aus Ungelesen-Stand | S | Sim |
| 18 | Rich-Push + Direkt-Antwort | — → UNNotificationCategory „Antworten", Bild-Anhänge | M | Gerät |
| 19 | Zeitkritische Pushs + Sounds | Default → Interrupt-Level konfigurierbar, eigener Sound | S | Gerät |
| 20 | Review-Prompt | — → Store-Review-API am richtigen Moment (nach erfolgreichem Senden) | S | Sim-Gate |

## Etappe 3 — Audio nativ

| # | Punkt | Ist → Ziel | Aufw. | Verifikation |
|---|---|---|---|---|
| 21 | Audio-Session | WKWebView-Default → `.playAndRecord`+`.voiceChat` für Voice, `.playback` für Stream/Watch (native Schaltstelle) | S–M | Sim+Gerät |
| 22 | Echo-Unterdrückung | Nur RNNoise (web, lazy) → System-AEC dazu, Kombination am Gerät messen | S | Gerät |
| 23 | Ton im Hintergrund/gesperrt | `UIBackgroundModes` fehlt → `audio`-Mode + Session; Display zu ≠ Voice tot | M | Gerät |
| 24 | Bluetooth/Auto/Headset | Nur Android ([audioRoute.ts](../../web/src/lib/platform/audioRoute.ts)) → AVAudioSession-Routing (AirPlay, Auto, Headset) | M | Gerät |
| 25 | Lockscreen-/Control-Center-Steuerung | — → MPNowPlayingInfoCenter + Remote-Commands für Watch/Stream | M | Sim+Gerät |
| 26 | GSM-Unterbrechung | Telefonanruf killt Session → Interruption-Observer + WebRTC-Resume | S–M | Gerät |

## Etappe 4 — Media-Show

| # | Punkt | Ist → Ziel | Aufw. | Verifikation |
|---|---|---|---|---|
| 27 | Stream quer/Vollbild | Portrait-Lock statisch → Orientierungsfreiheit nur mit angedocktem Stream (Android-Parität) | M | Sim+Gerät |
| 28 | Live Activity / Dynamic Island | — → ActivityKit: „Im Sprachkanal X", Stream-Zuschauer; interaktive Aktionen | L | Sim (Island vorhanden) |
| 29 | Picture-in-Picture | Web-Eckfenster → echtes System-PiP über alle Apps (AVPictureInPictureController) | L | Sim+Gerät |
| 30 | AirPlay | — → AVRoutePickerView | M | Gerät |
| 31 | Wake-Lock verifizieren | `navigator.wakeLock` vorhanden → Verhalten im WKWebView am Gerät prüfen, ggf. nativ ersetzen | S | Gerät |
| 32 | Lightbox Pinch-Zoom | kein Gesture-Code → Pinch/Doppel-Tap-Zoom für Bilder | S | Sim |

## Etappe 5 — Integrität & Übernahme (angepasst: ohne OAuth)

| # | Punkt | Ist → Ziel | Aufw. | Verifikation |
|---|---|---|---|---|
| 33 | BYO-Cloud einfrieren | Dropbox/GDrive-Verbindungen → neue sperren, Mobile-Sicherungs-UI gar nicht erst zeigen, Desktop auf Sync-Ordner+Nextcloud reduzieren; Bestandsläufe dokumentieren | S–M | Sim |
| 34 | QR-Scan für Kopplung | Web-Scanner nutzt `BarcodeDetector` (WebKit: nein) → nativer Scanner (AVFoundation) oder sauberer Tippen-Fallback | M | Gerät |
| 35 | Tokens in Keychain | JWTs im WebView-localStorage ([auth.svelte.ts](../../web/src/lib/stores/auth.svelte.ts)) → Keychain/Keystore für Pulse- + geerbte Cloud-Tokens | M | Sim |
| 36 | Berechtigungs-Priming | Unvorbereitete System-Dialoge → kontextuelle Vor-Erklärung (Mic/Kamera/Push) | M | Gerät |
| 37 | Offline-/Reconnect-UX | Weiß bei Netzverlust → Offline-Deckblatt, WS-Rückholung nach Netzwechsel | S–M | Sim (Vite killen) |
| 38 | Dynamic Type + VoiceOver-Basis | WKWebView ignoriert Systemschrift → Skalierung anbinden, Basis-Labels | M | Sim (content size) |
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
