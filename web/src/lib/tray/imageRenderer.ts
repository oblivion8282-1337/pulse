/**
 * Renderer-side Tray-Image-Generierung.
 *
 * Malt das Pulse-Mark in 100×100 mit optionalem Badge-Kreis unten-rechts.
 * Ergebnis als PNG data-URL via IPC an main → nativeImage.createFromDataURL
 * (robuster als Uint8Array über die contextBridge zu schicken).
 *
 * **100×100 ist eine Zeichenfläche, keine Ausgabegröße.** Hier stand bis zum
 * 2026-08-22 „Electron resizedet auf die native Tray-Größe" — das tut es
 * nicht. Die 100 Punkte landeten unverkleinert in einer Leiste, die 22 Punkte
 * hoch ist; auf dem Mac war das Symbol dadurch riesig und abgeschnitten.
 * Verkleinert wird jetzt in `desktop/electron/tray.ts`
 * (`setTrayImageFromDataUrl`), und zwar auf 44 Pixel mit Skalierungsfaktor 2,
 * damit es auf Retina scharf bleibt. Grosszügig hier zu malen ist weiterhin
 * richtig — es gibt der Verkleinerung Substanz.
 */

export type TrayState = 'normal' | 'mute' | 'deaf';

const STATE_COLORS: Record<TrayState, string> = {
  normal: '#10B981',
  mute: '#EF4444',
  deaf: '#3B82F6',
};

/** Badge-Inhalt: Mentions (@) gewinnen vor unread (dringender). */
export function badgeContent(unread: number, mentions: number): { text: string; fontSize: number } | null {
  if (mentions > 0) return { text: '@', fontSize: 30 };
  if (unread > 0) return { text: unread > 99 ? '99+' : String(unread), fontSize: 22 };
  return null;
}

export function renderTrayPng(state: TrayState, unread: number, mentions: number): string {
  const c = document.createElement('canvas');
  c.width = 100;
  c.height = 100;
  const ctx = c.getContext('2d')!;

  // Status-Mark: rounded rect in Statusfarbe.
  ctx.fillStyle = STATE_COLORS[state];
  ctx.beginPath();
  ctx.roundRect(0, 0, 100, 100, 24);
  ctx.fill();

  // Konzentrische weiße Kreise (Mockup-Variante mit <symbol>+<use>+url()
  // hatte Kompatibilitätsprobleme — direkt auf dem Canvas gemalt).
  const rings = [
    { r: 40, stroke: 'rgba(255,255,255,0.28)', lw: 2.5 },
    { r: 27, stroke: 'rgba(255,255,255,0.55)', lw: 3.5 },
    { r: 14, stroke: 'rgba(255,255,255,0.92)', lw: 4 },
  ];
  for (const ring of rings) {
    ctx.strokeStyle = ring.stroke;
    ctx.lineWidth = ring.lw;
    circle(ctx, 50, 50, ring.r);
    ctx.stroke();
  }
  ctx.fillStyle = '#FFFFFF';
  circle(ctx, 50, 50, 5.5);
  ctx.fill();

  // Badge-Kreis unten-rechts (einheitlich für alle Status-Farben, damit der
  // Badge unabhängig vom Status-Mark identisch aussieht). Fill + Stroke auf
  // demselben Path statt zwei separaten arc()-Aufrufen.
  const badge = badgeContent(unread, mentions);
  if (badge) {
    circle(ctx, 76, 76, 22);
    ctx.fillStyle = '#EF4444';
    ctx.fill();
    // Schwarzer Stroke trennt den Badge vom hellen Tray-Panel-Hintergrund.
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `700 ${badge.fontSize}px Inter, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(badge.text, 76, 76);
  }

  return c.toDataURL('image/png');
}

function circle(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
}
