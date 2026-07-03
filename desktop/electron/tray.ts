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
 * `com.howispulse.Pulse` manifest grants `org.kde.StatusNotifierWatcher` so
 * the tray works without bus-policy hacks.
 *
 * Status overlay: renderer pushes state over `tray:setStatus` (tooltip + OS
 * badge) and a rendered PNG with the live badge over `tray:setImage`.
 */

import { Tray, Menu, BrowserWindow, app, nativeImage } from 'electron';
import * as path from 'node:path';

let tray: Tray | null = null;
/** Lazy-cached nativeImage instances, keyed by state name. */
const icons = new Map<string, Electron.NativeImage>();

type Status = 'normal' | 'mute' | 'deaf';

export interface TrayStatus {
  /** Mic stummgeschaltet (nicht "PTT off" — PTT ist semantisch keine Stummschaltung). */
  muted?: boolean;
  /** Deaf (alle Remote-Audio gemutet). Impliziert Mute visuell → gewinnt. */
  deafened?: boolean;
  /** Anzahl ungelesener Nachrichten über alle Channels. 0 = nichts. */
  unread?: number;
  /** Anzahl @-Erwähnungen über alle Channels. 0 = nichts. */
  mentions?: number;
}

function pickIconName(s: TrayStatus): Status {
  if (s.deafened) return 'deaf';
  if (s.muted) return 'mute';
  return 'normal';
}

function tooltipText(s: TrayStatus): string {
  const parts: string[] = ['Pulse'];
  if (s.deafened) parts.push('Taub');
  else if (s.muted) parts.push('Mikro aus');
  else parts.push('Live');
  if (s.mentions && s.mentions > 0) parts.push(`${s.mentions} Erwähnung${s.mentions === 1 ? '' : 'en'}`);
  else if (s.unread && s.unread > 0) parts.push(`${s.unread} ungelesen`);
  return parts.join(' · ');
}

function loadIcon(name: Status): Electron.NativeImage {
  const cached = icons.get(name);
  if (cached) return cached;
  // Gepackte Builds: electron-builder packt `build-resources/tray/*.png`
  // als extraResources → liegen unter `process.resourcesPath + /tray/…`.
  // Dev (`pnpm dev` aus desktop/): cwd ist desktop/ → dort liegen sie unter
  // `build-resources/tray/`. Der Resolver probiert alle plausiblen Pfade,
  // nimmt den ersten Treffer.
  const candidates = [
    path.join(process.resourcesPath ?? '', 'tray', `tray-${name}@2x.png`),
    path.join(process.resourcesPath ?? '', 'tray', `tray-${name}.png`),
    path.join(__dirname, '..', '..', 'build-resources', 'tray', `tray-${name}@2x.png`),
    path.join(__dirname, '..', '..', 'build-resources', 'tray', `tray-${name}.png`),
    path.join(process.cwd(), 'build-resources', 'tray', `tray-${name}@2x.png`),
    path.join(process.cwd(), 'build-resources', 'tray', `tray-${name}.png`),
  ];
  for (const p of candidates) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) {
      icons.set(name, img);
      return img;
    }
  }
  // Fallback: empty image (Electron shows nothing rather than the default Electron icon).
  const empty = nativeImage.createEmpty();
  icons.set(name, empty);
  return empty;
}

export function createTray(
  getWindow: () => BrowserWindow | null,
  requestQuit: () => void
): Tray {
  // Initial state = "normal" so we always have SOMETHING drawn, even before the
  // renderer pushes its first status update (avoids a brief Electron-default-icon flash).
  const icon = loadIcon('normal');
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

/** Tooltip + OS taskbar badge (macOS Dock, Windows taskbar) aus dem
 *  Renderer-Status. Das Tray-Image selbst updated `setTrayImageFromDataUrl`,
 *  damit der Renderer den Live-Badge (Counter / @) dynamisch zeichnet. */
export function applyTrayStatus(s: TrayStatus): void {
  if (!tray) return;
  tray.setToolTip(tooltipText(s));
  // Badge count: macOS shows it on the Dock, Windows on the taskbar. Linux
  // ignores it (most DEs don't surface it; matching Electron's docs).
  const count = s.mentions && s.mentions > 0 ? s.mentions : (s.unread ?? 0);
  try {
    app.setBadgeCount(count);
  } catch {
    // app.setBadgeCount can throw on some Linux distros without a badge backend;
    // never crash on a cosmetic update.
  }
}

/** Tray-Icon aus einem vom Renderer gerenderten PNG (Canvas → data: URL),
 *  für den dynamischen Badge. `tray.setImage(empty)` würde das Icon löschen
 *  → Electron-Default-Flash; daher bei ungültigem Input silent drop. */
export function setTrayImageFromDataUrl(dataUrl: string): void {
  if (!tray) return;
  if (!dataUrl.startsWith('data:image/')) return;
  const img = nativeImage.createFromDataURL(dataUrl);
  if (img.isEmpty()) return;
  tray.setImage(img);
}
