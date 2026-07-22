/**
 * Lesbarer Anzeigename eines capturebaren Fensters.
 *
 * Der Windows-Sidecar liefert pro Fenster drei Namensquellen (`list_windows`):
 *   - `app_display` — `FileDescription` aus der Versions-Resource der EXE, also
 *     das, was auch der Task-Manager zeigt („Google Chrome", „Windows-Explorer").
 *     Beste Quelle, aber **oft nicht vorhanden**: gerade Spiele und Go-/Rust-
 *     Binaries bringen gar keinen Versions-Block mit (gemessen 2026-07-22:
 *     Super Meat Boy → nichts).
 *   - `app` — der rohe Dateiname (`SuperMeatBoy.exe`).
 *   - `title` — der Fenstertitel; aussagekräftig, aber flüchtig (Browser-Tab,
 *     Terminal-Kommando) und darum nur letzter Ausweg.
 *
 * Diese Reihenfolge bildet `windowDisplayName` ab. Genutzt vom Quellen-Picker
 * UND von `label.ts` (dem Namen, den ZUSCHAUER am Stream sehen) — beide sollen
 * dieselbe Anwendung gleich benennen.
 */
import type { GsrWindow } from './gsr';

/** `"SuperMeatBoy.exe"` → `"Super Meat Boy"`. Nur für den Fallback-Pfad. */
export function prettifyExeName(raw: string): string {
  const base = raw.trim().replace(/\.exe$/i, '');
  if (!base) return '';
  const spaced = base
    // camelCase-Grenze: „SuperMeat" → „Super Meat"
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    // Akronym vor Wort: „HTMLParser" → „HTML Parser" (aber „GTAV" bleibt ganz)
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Anzeigename eines Fensters — siehe Modul-Doc für die Quellen-Reihenfolge. */
export function windowDisplayName(w: Pick<GsrWindow, 'app' | 'title' | 'app_display'>): string {
  const display = w.app_display?.trim();
  if (display) return display;
  const pretty = prettifyExeName(w.app ?? '');
  if (pretty) return pretty;
  return w.title?.trim() || '';
}

/**
 * Zweite Zeile einer Fenster-Kachel.
 *
 * Normalfall die Auflösung — analog zu den Bildschirm-Kacheln, und anders als
 * der Fenstertitel eine stabile, sachliche Angabe. Teilen sich aber MEHRERE
 * Fenster denselben Anzeigenamen (drei Terminal-Fenster, zwei Browser), wäre
 * die Auflösung nutzlos: dann ist der Titel das einzige Unterscheidungsmerkmal
 * und gewinnt.
 */
export function windowSubtitle(w: GsrWindow, ambiguous: boolean): string {
  const title = w.title?.trim();
  if (ambiguous && title) return title;
  if (w.width && w.height) return `${w.width}×${w.height}`;
  return title ?? '';
}

/** Anzeigenamen, die in der Liste mehrfach vorkommen — Eingabe für `ambiguous`. */
export function ambiguousNames(windows: GsrWindow[]): Set<string> {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const w of windows) {
    const name = windowDisplayName(w);
    if (!name) continue;
    if (seen.has(name)) dupes.add(name);
    seen.add(name);
  }
  return dupes;
}
