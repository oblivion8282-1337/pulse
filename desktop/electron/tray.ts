/**
 * Pulse desktop shell — system tray (Discord-style).
 *
 * Closing the window hides it instead of quitting (handled in `main.ts`); the
 * tray icon is the only path back. Left-click toggles the window, right-click
 * shows a context menu with "Beenden" — that's the only way to actually quit.
 *
 * Linux note: the tray uses StatusNotifierItem (modern) or XEmbed (legacy) via
 * libappindicator. Most desktops (KDE, Cinnamon, XFCE, Hyprland+waybar) work
 * out of the box; bare GNOME needs the AppIndicator extension. In Flatpak the
 * `com.unicutmedia.Pulse` manifest grants `org.kde.StatusNotifierWatcher` so
 * the tray works without bus-policy hacks.
 */

import { Tray, Menu, BrowserWindow, nativeImage } from 'electron';
import * as path from 'node:path';

let tray: Tray | null = null;

export function createTray(
  getWindow: () => BrowserWindow | null,
  requestQuit: () => void
): Tray {
  // `dist/main.cjs` lives one level below `electron/`, where icon.png sits.
  const iconPath = path.join(__dirname, '..', 'icon.png');
  const raw = nativeImage.createFromPath(iconPath);
  // The 512px app icon would eat the entire tray on KDE/Plasma — pre-resize.
  // (Electron resizes internally too, but the result is platform-dependent.)
  const icon = raw.isEmpty() ? raw : raw.resize({ width: 22, height: 22 });

  tray = new Tray(icon);
  tray.setToolTip('Pulse');

  const showWindow = (): void => {
    const win = getWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  const menu = Menu.buildFromTemplate([
    { label: 'Pulse anzeigen', click: showWindow },
    { type: 'separator' },
    { label: 'Beenden', click: requestQuit },
  ]);
  tray.setContextMenu(menu);

  // Left-click: toggle visibility (matches Discord's tray behavior).
  tray.on('click', () => {
    const win = getWindow();
    if (!win) return;
    if (win.isVisible() && !win.isMinimized()) win.hide();
    else showWindow();
  });

  return tray;
}
