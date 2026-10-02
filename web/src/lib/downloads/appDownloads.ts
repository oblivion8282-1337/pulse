/**
 * App-Download-Quellen für die Webseite (Login-Screen + Einstellungen).
 *
 * Die Artefakte liegen auf dem Prod-Server (siehe infra/prod/web-nginx.conf):
 *  - Windows: NSIS-Installer aus dem Auto-Update-Feed (/updates/win/,
 *    `Pulse-Setup-latest.exe` zeigt immer auf den neuesten Build).
 *  - Linux: Flatpak-Repo unter /flatpak/ — kein Einzeldatei-Download,
 *    Installation per `flatpak install --from <flatpakref>` (oder die
 *    .flatpakref-Datei in GNOME Software öffnen).
 *  - Android: manuell bereitgestellte APK unter /downloads/.
 *
 * Absolute URLs (nicht relativ), damit die Links auch aus einer lokalen
 * Dev-Umgebung heraus auf die echten Artefakte zeigen.
 *
 * ACHTUNG — dieselben Konstanten stehen ein zweites Mal in
 * `web/static/landing.js` (Landingpage auf `/`). Die Datei laeuft ohne
 * Bundler und kann hier nicht importieren, also **synchron halten**: wer eine
 * URL hier aendert, aendert sie dort mit.
 */

const BASE = 'https://howispulse.com';

export const WINDOWS_INSTALLER_URL = `${BASE}/updates/win/Pulse-Setup-latest.exe`;
export const ANDROID_APK_URL = `${BASE}/downloads/pulse-latest.apk`;
// macOS: unsigned Apple-Silicon .dmg, served from /downloads/ like the APK
// (scp the build to ~/pulse/downloads/Pulse-latest.dmg). First launch needs
// right-click → Open (Gatekeeper), since it isn't notarized.
export const MAC_DMG_URL = `${BASE}/downloads/Pulse-latest.dmg`;
export const LINUX_FLATPAKREF_URL = `${BASE}/flatpak/com.howispulse.Pulse.flatpakref`;
export const LINUX_INSTALL_COMMAND = `flatpak install --from ${LINUX_FLATPAKREF_URL}`;

// ── Pulse Server (App-Hosting, seit 0.1.92) ─────────────────────────────────
// Eigenes Server-Hosting aus der App heraus. Windows hat einen EIGENEN
// Auto-Update-Feed (/updates/win-server/, CI win-build-server.yml schreibt
// Pulse-Server-Setup-latest.exe dort hin); Linux teilt sich das Flatpak-Repo,
// eigene App-ID com.howispulse.PulseServer; macOS zieht der build-server-Job
// in mac-build.yml als unsigniertes DMG nach /downloads/ (gleiches Muster wie
// der Client).
export const WINDOWS_SERVER_INSTALLER_URL = `${BASE}/updates/win-server/Pulse-Server-Setup-latest.exe`;
export const MAC_SERVER_DMG_URL = `${BASE}/downloads/Pulse-Server-latest.dmg`;
export const LINUX_SERVER_FLATPAKREF_URL = `${BASE}/flatpak/com.howispulse.PulseServer.flatpakref`;
export const LINUX_SERVER_INSTALL_COMMAND = `flatpak install --from ${LINUX_SERVER_FLATPAKREF_URL}`;
