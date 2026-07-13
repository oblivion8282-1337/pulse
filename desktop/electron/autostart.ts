/**
 * Autostart beim Anmelden (Server-App).
 *
 *  - Win/Mac: `app.setLoginItemSettings` (per Dep injiziert — dieses Modul
 *    bleibt electron-frei für node:test).
 *  - Linux: XDG-Autostart-Datei nach `~/.config/autostart/` — das Server-
 *    Flatpak hat `--filesystem=host`, das Verzeichnis ist also DIREKT
 *    beschreibbar (kein Background-Portal/D-Bus nötig; Electron hat dafür
 *    ohnehin keine API und neue Dependencies sind tabu). Exec-Zeile im
 *    Flatpak = `flatpak run <app-id>`, sonst der Electron-Binary-Pfad.
 *
 * Der Schalter-Zustand lebt im Store (`serverAutostart`); diese Funktionen
 * setzen nur den OS-Zustand um — idempotent, damit der Boot-Pfad sie bei
 * jedem Start zum Abgleich aufrufen kann.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FLATPAK_SERVER_APP_ID = 'com.howispulse.PulseServer';

/** Exec-Zeile für die .desktop-Datei. execPath in Anführungszeichen —
 *  Installationspfade mit Leerzeichen sind sonst kaputte Exec-Keys. */
export function linuxExecLine(flatpak: boolean, execPath: string): string {
  return flatpak ? `flatpak run ${FLATPAK_SERVER_APP_ID}` : `"${execPath}"`;
}

/** Inhalt der XDG-Autostart-Datei. X-Flatpak markiert den Eintrag als
 *  Flatpak-verwaltet (Desktop-Umgebungen zeigen ihn dann korrekt an). */
export function autostartDesktopEntry(execLine: string, flatpak: boolean): string {
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Pulse Server',
    `Exec=${execLine}`,
    'X-GNOME-Autostart-enabled=true',
  ];
  if (flatpak) lines.push(`X-Flatpak=${FLATPAK_SERVER_APP_ID}`);
  return lines.join('\n') + '\n';
}

export interface AutostartDeps {
  platform: NodeJS.Platform;
  /** Win/Mac: app.setLoginItemSettings({ openAtLogin }) — injiziert. */
  setLoginItems(openAtLogin: boolean): void;
  flatpak: boolean;
  execPath: string;
  home: string;
}

/** OS-Autostart setzen/entfernen. Fehler → ok:false (UI zeigt den Schalter
 *  dann als nicht übernommen), nie ein throw. */
export function applyAutostart(enabled: boolean, deps: AutostartDeps): { ok: boolean } {
  try {
    if (deps.platform === 'win32' || deps.platform === 'darwin') {
      deps.setLoginItems(enabled);
      return { ok: true };
    }
    if (deps.platform !== 'linux') return { ok: false };
    const dir = join(deps.home, '.config', 'autostart');
    const file = join(dir, 'pulse-server.desktop');
    if (enabled) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, autostartDesktopEntry(linuxExecLine(deps.flatpak, deps.execPath), deps.flatpak), 'utf8');
    } else {
      rmSync(file, { force: true });
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
