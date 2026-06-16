/**
 * Nativer-Hülle-Update-Hinweis (Electron-Apps: Windows / macOS / Linux-Flatpak).
 *
 * Zwei-Ebenen-Modell — siehe den Reload-Toast in `+layout.svelte` für Ebene 1:
 *  - Ebene 1 (Web-Inhalt): SvelteKits `updated`-Store → „Neu laden". Greift bei
 *    JEDEM Web-Deploy, auf allen Plattformen identisch (alle Apps laden die
 *    Web-App remote). Das ist der Alltagsfall.
 *  - Ebene 2 (HIER): die native Hülle (Electron-Shell + Streaming-Sidecar).
 *    Ändert sich nur bei einem echten nativen Release.
 *
 * Quelle = `/native.json` (committed unter `web/static/`, nginx no-cache). Sie
 * führt pro Plattform die zuletzt VERÖFFENTLICHTE native Version. Wir vergleichen
 * sie gegen die im Build eingebackene `window.pulse.appVersion`. Ein reiner
 * Web-Deploy fasst `native.json` nicht an → kein Fehlalarm.
 *
 * Aktion je Plattform (die Auslieferung ist OS-nativ — nur der Hinweis ist
 * vereinheitlicht):
 *  - win32  → KEIN Toast: electron-updater lädt selbst + zeigt sein eigenes
 *             „Update bereit"-Banner (updater.ts). Doppel-Benachrichtigung
 *             vermeiden.
 *  - darwin → 'download': unsigniert → manueller DMG-Download (Link). Sobald
 *             signiert (Stufe B), übernimmt auch hier electron-updater → dann
 *             ebenfalls unterdrücken.
 *  - linux  → 'flatpak': Flatpak/Software-Verwaltung besitzt das Update; in der
 *             App nur ein Nudge mit `flatpak update`.
 */

import { isElectron, isWindows, isMac, isLinux } from './runtime';
import { MAC_DMG_URL } from '$lib/downloads/appDownloads';

export type NativeUpdateAction = 'download' | 'flatpak';

export interface NativeUpdateInfo {
  action: NativeUpdateAction;
  /** Latest published native version for this platform. */
  latest: string;
  /** Version this app shell is running. */
  current: string;
  /** Set only for `action === 'download'` (macOS DMG). */
  downloadUrl?: string;
}

interface NativeManifestEntry {
  version: string;
  downloadUrl?: string;
}

const STORAGE_KEY = 'pulse.nativeUpdate.lastSeen';

/**
 * Numeric dotted-version compare. `>0` if a is newer than b, `<0` if older,
 * `0` if equal. Malformed/non-numeric segments make it return `0` (treated as
 * „nicht neuer" — fail safe, never a spurious toast).
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = parseInt(pa[i] ?? '0', 10);
    const y = parseInt(pb[i] ?? '0', 10);
    if (Number.isNaN(x) || Number.isNaN(y)) return 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** `process.platform`-style key from the preload bridge, falling back to UA
 *  detection so the check also works on shells built before `pulse.os` existed. */
function detectOs(): string | null {
  const fromBridge = typeof window !== 'undefined' ? window.pulse?.os : undefined;
  if (fromBridge) return fromBridge;
  if (isWindows()) return 'win32';
  if (isMac()) return 'darwin';
  if (isLinux()) return 'linux';
  return null;
}

/**
 * Returns the native update to surface, or `null` when there's nothing to show:
 * not in the desktop shell, version unknown (dev), already up-to-date, Windows
 * (electron-updater owns its UX), or any fetch/parse failure (Vite dev serves no
 * `/native.json` → 404 → silently no toast). Never throws.
 */
export async function checkNativeUpdate(): Promise<NativeUpdateInfo | null> {
  if (!isElectron() || typeof window === 'undefined') return null;

  const current = window.pulse?.appVersion;
  // '0.0.0' = unpackaged dev shell; skip (it would always look „behind").
  if (!current || current === '0.0.0') return null;

  const os = detectOs();
  if (!os) return null;

  // Windows: electron-updater downloads silently and shows its own restart
  // banner → never surface a second toast here.
  if (os === 'win32') return null;

  let entry: NativeManifestEntry | undefined;
  try {
    const res = await fetch('/native.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const manifest = (await res.json()) as Record<string, NativeManifestEntry>;
    entry = manifest[os];
  } catch {
    return null; // offline / 404 in dev → no toast
  }
  if (!entry?.version) return null;
  if (compareVersions(entry.version, current) <= 0) return null; // up-to-date

  if (os === 'darwin') {
    return {
      action: 'download',
      latest: entry.version,
      current,
      downloadUrl: entry.downloadUrl ?? MAC_DMG_URL,
    };
  }
  // linux (and any other future non-auto platform)
  return { action: 'flatpak', latest: entry.version, current };
}

/** True if this exact version was already shown and dismissed (once-per-version,
 *  mirrors the changelog gate's `lastSeen` pattern). */
export function nativeUpdateAlreadySeen(latest: string): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === latest;
  } catch {
    return false;
  }
}

/** Remember that the toast for `latest` was shown, so it doesn't reappear on
 *  every boot until the next native release. */
export function markNativeUpdateSeen(latest: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, latest);
  } catch {
    // localStorage unavailable (private mode etc.) — worst case the toast shows
    // again next boot; harmless.
  }
}
