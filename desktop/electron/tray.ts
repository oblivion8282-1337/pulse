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
/** 'server-' in der Server-App → lädt tray-server-*.png (Herzschlag) statt der
 *  Client-Glyphe; gesetzt einmalig von createTray. */
let iconPrefix = '';

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
  const parts: string[] = [app.getName()];
  if (s.deafened) parts.push('Taub');
  else if (s.muted) parts.push('Mikro aus');
  else parts.push('Live');
  if (s.mentions && s.mentions > 0) parts.push(`${s.mentions} Erwähnung${s.mentions === 1 ? '' : 'en'}`);
  else if (s.unread && s.unread > 0) parts.push(`${s.unread} ungelesen`);
  return parts.join(' · ');
}

function loadIcon(name: Status): Electron.NativeImage {
  const file = `tray-${iconPrefix}${name}`;
  const cached = icons.get(file);
  if (cached) return cached;
  // Gepackte Builds: electron-builder packt `build-resources/tray/*.png`
  // als extraResources → liegen unter `process.resourcesPath + /tray/…`.
  // Dev (`pnpm dev` aus desktop/): cwd ist desktop/ → dort liegen sie unter
  // `build-resources/tray/`. Der Resolver probiert alle plausiblen Pfade,
  // nimmt den ersten Treffer.
  //
  // **Immer die 1x-Datei, NIE `@2x` direkt** (bis 2026-08-22 stand die
  // `@2x`-Fassung zuerst in dieser Liste, und genau das war der Fehler):
  // `createFromPath` liest die genannte Datei als NORMALE Auflösung. Auf ein
  // `@2x` gezeigt landeten damit 44 Pixel in einer Leiste, die 22 Punkte hoch
  // ist — auf dem Mac sichtbar als riesiges, oben und unten abgeschnittenes
  // Symbol. Zeigt man dagegen auf die Basis-Datei, sucht Electron die
  // `@2x`-Fassung von selbst daneben und hängt sie als Retina-Darstellung
  // ein. Die Dateien liegen bereits in beiden Größen (22 und 44) bereit.
  const candidates = [
    path.join(process.resourcesPath ?? '', 'tray', `${file}.png`),
    path.join(__dirname, '..', '..', 'build-resources', 'tray', `${file}.png`),
    path.join(process.cwd(), 'build-resources', 'tray', `${file}.png`),
  ];
  for (const p of candidates) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) {
      icons.set(file, img);
      return img;
    }
  }
  // Fallback: empty image (Electron shows nothing rather than the default Electron icon).
  const empty = nativeImage.createEmpty();
  icons.set(file, empty);
  return empty;
}

export function createTray(
  getWindow: () => BrowserWindow | null,
  requestQuit: () => void,
  opts: { variant?: 'client' | 'server' } = {}
): Tray {
  iconPrefix = opts.variant === 'server' ? 'server-' : '';
  // Initial state = "normal" so we always have SOMETHING drawn, even before the
  // renderer pushes its first status update (avoids a brief Electron-default-icon flash).
  const icon = loadIcon('normal');
  tray = new Tray(icon);
  tray.setToolTip(app.getName());

  const showWindow = (): void => {
    const win = getWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  const menu = Menu.buildFromTemplate([
    { label: `${app.getName()} anzeigen`, click: showWindow },
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

/**
 * Kantenlänge des Tray-Symbols in **Punkten** (nicht Pixeln).
 *
 * 22 ist das Mass der macOS-Menüleiste; Windows und Linux kommen damit
 * ebenfalls zurecht (dort skaliert die Shell ohnehin selbst nach).
 */
const TRAY_PUNKTE = 22;

/** Tray-Icon aus einem vom Renderer gerenderten PNG (Canvas → data: URL),
 *  für den dynamischen Badge. `tray.setImage(empty)` würde das Icon löschen
 *  → Electron-Default-Flash; daher bei ungültigem Input silent drop.
 *
 *  **Das Bild MUSS hier verkleinert werden.** Der Renderer malt in 100×100
 *  (`web/src/lib/tray/imageRenderer.ts`), und dort stand bis zum 2026-08-22 die
 *  Annahme, "Electron resizedet auf die native Tray-Größe". Das tut es nicht:
 *  `createFromDataURL` nimmt die Bildpunkte als normale Auflösung, 100 Punkte
 *  in einer 22-Punkte-Leiste. Auf dem Mac war das Symbol dadurch riesig und
 *  oben wie unten abgeschnitten.
 *
 *  Verkleinert wird auf die DOPPELTE Punktzahl und das Ergebnis als
 *  Retina-Darstellung eingehängt (`scaleFactor: 2`): so bleibt das Symbol auf
 *  einem Retina-Schirm scharf, statt aus 22 Pixeln hochgerechnet zu werden.
 *  Der Umweg über `toPNG()` ist nötig, weil sich der Skalierungsfaktor nur
 *  beim Erzeugen aus einem Puffer setzen lässt. */
export function setTrayImageFromDataUrl(dataUrl: string): void {
  if (!tray) return;
  if (!dataUrl.startsWith('data:image/')) return;
  const roh = nativeImage.createFromDataURL(dataUrl);
  if (roh.isEmpty()) return;
  const kante = TRAY_PUNKTE * 2;
  const png = roh.resize({ width: kante, height: kante, quality: 'best' }).toPNG();
  const img = nativeImage.createFromBuffer(png, { scaleFactor: 2 });
  // Schlägt der Puffer-Weg fehl (leeres PNG), lieber das unskalierte Bild als
  // gar keines — ein leeres Icon zeigt Electrons Standard-Symbol.
  tray.setImage(img.isEmpty() ? roh : img);
}
