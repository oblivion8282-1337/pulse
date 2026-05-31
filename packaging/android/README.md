# Pulse — Android-App (TWA)

Eine **Trusted Web Activity (TWA)**: eine dünne Android-Hülle, die `https://howispulse.com`
in einem echten Chrome-Unterbau lädt. Gebaut mit [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap).

Chat + Voice (LiveKit/WebRTC) funktionieren. **HQ-Screen-Streaming nicht** — das ist Desktop/Electron-only.

## Was hier eingecheckt ist

- `twa-manifest.json` — die App-Konfiguration (Paket-ID, Name, Icons, Signatur-Verweis). **Single Source of Truth.**
- `assetlinks.json` — Digital-Asset-Links-Datei (öffentlich, kein Geheimnis). Siehe „Browserleiste entfernen".
- `README.md` — dieses Dokument.

**Nicht** eingecheckt (gitignored):
- `android.keystore` + `KEYSTORE_CREDENTIALS.txt` — der **Signaturschlüssel** und sein Passwort. **GEHEIM. Sicher
  sichern!** Play-Store-Updates müssen mit *genau* diesem Schlüssel signiert sein — geht er verloren, kann die App
  im Store nie wieder aktualisiert werden.
- Das generierte Gradle-Projekt (`app/`, `gradle/`, `gradlew`, `build.gradle`, …) — wird aus `twa-manifest.json`
  reproduzierbar neu erzeugt.
- `*.apk` / `*.aab` — die Build-Artefakte.

## Voraussetzungen (einmalig)

- **JDK 17** — z. B. `sudo pacman -S jdk17-openjdk` (liegt unter `/usr/lib/jvm/java-17-openjdk`).
- **Android SDK** — cmdline-tools + `platform-tools` + `platforms;android-35` + `build-tools;35.0.0`, hier unter
  `~/Android/Sdk`. Bubblewrap-Quirk: es braucht einen Symlink `~/Android/Sdk/tools` → `cmdline-tools/latest`.
- **Bubblewrap CLI** — `npm i -g @bubblewrap/cli`.
- `~/.bubblewrap/config.json` zeigt auf JDK + SDK:
  ```json
  { "jdkPath": "/usr/lib/jvm/java-17-openjdk", "androidSdkPath": "/home/michael/Android/Sdk" }
  ```
  Check: `bubblewrap doctor` → „Your jdkpath and androidSdkPath are valid."

## Neu bauen

Das Launcher-Icon wird beim Generieren von einer **URL** geholt (Bubblewrap liest keine lokalen Dateien). Die
512px-PNGs liegen in `web/static/pulse-icon-512.png` + `pulse-icon-maskable-512.png`. Für den Build serviert man sie
kurz lokal:

```fish
# 1) Icons lokal servieren (separates Terminal)
cd web/static; python3 -m http.server 8099 --bind 127.0.0.1

# 2) bauen
cd packaging/android
set -x BUBBLEWRAP_KEYSTORE_PASSWORD (grep '^storepass=' KEYSTORE_CREDENTIALS.txt | cut -d= -f2-)
set -x BUBBLEWRAP_KEY_PASSWORD $BUBBLEWRAP_KEYSTORE_PASSWORD
set -x JAVA_HOME /usr/lib/jvm/java-17-openjdk
set -x ANDROID_HOME $HOME/Android/Sdk
bubblewrap update --manifest ./twa-manifest.json   # Projekt aus twa-manifest.json regenerieren
bubblewrap build --skipPwaValidation               # APK + AAB bauen & signieren
```

Ergebnis:
- `app-release-signed.apk` — direkt auf ein Gerät installierbar (`adb install -r app-release-signed.apk` oder
  Datei aufs Handy kopieren + öffnen; „Installation aus unbekannten Quellen" muss erlaubt sein).
- `app-release-bundle.aab` — Upload-Format für den Google Play Store.

> Wenn die Icons hübscher/anders sollen: PNGs in `web/static/` ersetzen, dann neu bauen.
> `bubblewrap update` erhöht bei jedem Lauf automatisch `appVersionCode` (Play Store verlangt steigende Nummern).

## Browserleiste entfernen (Digital Asset Links)

Solange die App **nicht** verifiziert ist, zeigt sie oben eine dünne Chrome-Adressleiste (Custom-Tab-Fallback).
Um sie als „echte" Vollbild-App laufen zu lassen, muss `assetlinks.json` öffentlich erreichbar sein unter:

```
https://howispulse.com/.well-known/assetlinks.json
```

Umsetzung im Web-Projekt: Datei nach `web/static/.well-known/assetlinks.json` legen (der `adapter-static`-Build
kopiert sie nach `build/.well-known/…`, nginx liefert sie vor dem SPA-Fallback aus, weil die Datei existiert).
Danach erkennt Android beim App-Start die Verknüpfung und blendet die Leiste aus.

**Wichtig:** Der `sha256_cert_fingerprints`-Wert in `assetlinks.json` muss zum *tatsächlich* signierenden Schlüssel
passen. Lädt man die App über den Play Store hoch, signiert Google sie u. U. mit *seinem* Schlüssel neu („Play App
Signing") — dann den Fingerprint aus der Play Console nehmen, nicht den hiesigen.

Aktueller Fingerprint (aus `android.keystore`):
`FA:18:0A:D0:DF:34:9B:95:E5:DD:84:FE:03:88:88:90:FF:E1:68:3D:7D:53:B2:8D:37:F4:CE:DE:C5:CA:C0:9A`
