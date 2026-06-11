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
 */

const BASE = 'https://howispulse.com';

export const WINDOWS_INSTALLER_URL = `${BASE}/updates/win/Pulse-Setup-latest.exe`;
export const ANDROID_APK_URL = `${BASE}/downloads/pulse-latest.apk`;
export const LINUX_FLATPAKREF_URL = `${BASE}/flatpak/com.howispulse.Pulse.flatpakref`;
export const LINUX_INSTALL_COMMAND = `flatpak install --from ${LINUX_FLATPAKREF_URL}`;
