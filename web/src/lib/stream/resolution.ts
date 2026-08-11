/**
 * Was eine gewählte Auflösungsstufe für die AKTUELLE Quelle bedeutet.
 *
 * Die Stufen (`RESOLUTION_VALUES`) sind quellenunabhängige Etiketten; was
 * tatsächlich gesendet wird, hängt von der Größe des gewählten Monitors bzw.
 * Fensters ab. Zwei Eigenheiten machten das Dropdown vorher irreführend:
 *
 *  - **Kein Hochskalieren.** Die Stufe ist eine BOX, in die das Bild
 *    seitenverhältniswahrend eingepasst wird; ist die Box größer als die
 *    Quelle, bleibt es bei der nativen Größe. „4K" auf einem 1440p-Monitor
 *    tat also schlicht nichts — die Option stand trotzdem in der Liste.
 *  - **Krumme Quellgrößen.** Ein Fenster mit 2041×1226 ergibt bei „1080p"
 *    nicht 1920×1080, sondern 1798×1080. Das stand nirgends.
 *
 * `fitWithinBox` spiegelt darum bewusst `stream_controller.rs::fit_within_box`
 * (und `ResolutionRequest::target_for` im Linux-Rust-Sidecar) — inklusive der
 * Rundung auf gerade Kantenlängen, die 4:2:0-Encoder verlangen. Weicht die
 * Spiegelung ab, zeigt die UI eine andere Größe an als gesendet wird; bei
 * Änderungen an einer der beiden Seiten also die andere mitziehen.
 */
import type { GsrMonitor, GsrWindow } from './gsr';
import { MONITOR_CAPTURE_PREFIX, WINDOW_CAPTURE_PREFIX } from './settingsCatalog';

/** Pixel-Box je Stufe — muss zu `ops/start.rs::parse_overrides` und
 *  `gsr-sidecar/stream_controller.py::_RESOLUTIONS` passen. */
export const RESOLUTION_BOXES: Readonly<Record<string, readonly [number, number]>> = {
  '4K': [3840, 2160],
  '1440p': [2560, 1440],
  '1080p': [1920, 1080],
  '720p': [1280, 720],
  '480p': [854, 480],
};

export type SourceSize = { width: number; height: number };

/** Seitenverhältniswahrend in die Box einpassen; nie hochskalieren, Kanten auf
 *  gerade Werte runden. Spiegel von `fit_within_box` (s. Modul-Doc). */
export function fitWithinBox(
  nativeW: number,
  nativeH: number,
  boxW: number,
  boxH: number,
): SourceSize {
  const even = (n: number) => Math.max(2, n & ~1);
  const scale = Math.min(boxW / Math.max(nativeW, 1), boxH / Math.max(nativeH, 1), 1);
  return {
    width: even(Math.round(nativeW * scale)),
    height: even(Math.round(nativeH * scale)),
  };
}

/**
 * Größe der gewählten Quelle, oder `null` wenn unbekannt.
 *
 * Unbekannt ist der Normalfall unter Linux (`capture_source === 'portal'`):
 * dort wählt der Wayland-Portal-Dialog die Quelle erst beim Stream-Start, vor
 * dem Start gibt es also nichts zu messen. Aufrufer zeigen dann die
 * ungefilterte Stufenliste wie bisher.
 */
export function sourceSize(
  captureSource: string | undefined | null,
  catalogs: { monitors: readonly GsrMonitor[]; windows: readonly GsrWindow[] },
): SourceSize | null {
  const src = (captureSource ?? '').trim();
  if (!src || src === 'portal') return null;

  if (src.startsWith(MONITOR_CAPTURE_PREFIX)) {
    const idx = Number(src.slice(MONITOR_CAPTURE_PREFIX.length));
    return dims(catalogs.monitors.find((m) => m.index === idx));
  }
  if (src.startsWith(WINDOW_CAPTURE_PREFIX)) {
    const id = Number(src.slice(WINDOW_CAPTURE_PREFIX.length));
    return dims(catalogs.windows.find((w) => w.id === id));
  }
  return null;
}

/** Größe eines Katalog-Eintrags — `null`, wenn er fehlt oder eine Kante 0 meldet. */
function dims(entry: { width: number; height: number } | undefined): SourceSize | null {
  if (!entry?.width || !entry.height) return null;
  return { width: entry.width, height: entry.height };
}

export type ResolutionOption = {
  /** Wire-Wert ('Native', '1080p', …) — unverändert. */
  value: string;
  /** Beschriftung im Dropdown. */
  label: string;
};

/**
 * Die Stufen, die für diese Quelle tatsächlich etwas bewirken — beschriftet
 * mit der Größe, die dabei herauskommt.
 *
 * Weggelassen wird jede Stufe, die keine Verkleinerung ergibt (Box ≥ Quelle):
 * sie wäre wirkungsgleich mit „Original" und hat den User bisher glauben
 * lassen, er streame in 4K. `Native` bleibt immer und trägt die native Größe
 * im Namen.
 *
 * Ohne bekannte Quellgröße (`size === null`) bleibt die Liste unverändert —
 * lieber die alte, etwas vage Beschriftung als eine erfundene Zahl.
 */
export function resolutionOptions(
  allowed: readonly string[],
  size: SourceSize | null,
  nativeLabel: string,
): ResolutionOption[] {
  const out: ResolutionOption[] = [];
  for (const value of allowed) {
    if (value === 'Native') {
      const label = size ? `${nativeLabel} (${size.width}×${size.height})` : nativeLabel;
      out.push({ value, label });
      continue;
    }
    const box = RESOLUTION_BOXES[value];
    // Ohne Quellgröße bzw. bei unbekannter Stufe: unverändert durchreichen.
    if (!size || !box) {
      out.push({ value, label: value });
      continue;
    }
    // Deckt die Box die Quelle in BEIDEN Richtungen ab, gibt es keine
    // Verkleinerung → wirkungsgleich mit „Original", also weglassen.
    //
    // Der Test hängt bewusst an der Box und nicht am eingepassten Ergebnis:
    // `fitWithinBox` rundet auf gerade Kanten ab, eine ungerade Quelle (Fenster
    // 2041×1226) käme also als 2040×1226 zurück und ein Ergebnis-Vergleich
    // hielte das für eine echte Verkleinerung — „4K — 2040×1226" stünde wieder
    // in der Liste, genau der Unsinn, den dieser Filter beseitigen soll.
    if (box[0] >= size.width && box[1] >= size.height) continue;
    const fitted = fitWithinBox(size.width, size.height, box[0], box[1]);
    out.push({ value, label: `${value} — ${fitted.width}×${fitted.height}` });
  }
  return out;
}
