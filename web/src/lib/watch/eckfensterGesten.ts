/**
 * Die reine Rechnung hinter den Gesten des PiP-Eckfensters: welche Ecke ein
 * Finger hält, ob zwei Finger eine Diagonale bilden, wie sich Grösse und Lage
 * beim Zusammenziehen ändern, und wie das Fenster am Bildschirm bleibt.
 *
 * **Das Modul hat bewusst KEINEN Laufzeit-Import** — es wird von Nodes
 * eingebautem Läufer geprüft (`pnpm test:unit`), und der löst die
 * erweiterungslosen Importe der Web-Quellen nicht auf.
 *
 * **Warum getrennt von der Komponente:** die Diagonal-Bedingung ist die
 * einzige Stelle, an der ein Denkfehler stumm bliebe — ein Zusammenziehen, das
 * fälschlich als Verschieben zählt, sieht aus wie „ruckelt eben", und
 * umgekehrt. Am Markup ist das nicht prüfbar, an einer Funktion mit vier
 * Zahlen schon.
 */

export type Ecke = 'ol' | 'or' | 'ul' | 'ur';

export interface Rechteck {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface Lage {
  readonly top: number;
  readonly left: number;
}

export interface Groesse {
  readonly w: number;
  readonly h: number;
}

/** px — ab hier gilt ein Griff als „an der Ecke". */
export const ECKEN_TOLERANZ = 34;
/** px — darunter gilt ein Pointer-Down als Tipp, nicht als Ziehen. */
export const TAP_TOLERANZ = 8;
/** px Abstand zum Bildschirmrand. */
export const MARGIN = 16;
export const MIN_W = 160;
export const MIN_H = 100;

/** Welche Ecke des Rechtecks liegt unter (x, y)? `null` = keine. */
export function eckeVon(r: Rechteck, x: number, y: number): Ecke | null {
  const links = x - r.left <= ECKEN_TOLERANZ;
  const rechts = r.right - x <= ECKEN_TOLERANZ;
  const oben = y - r.top <= ECKEN_TOLERANZ;
  const unten = r.bottom - y <= ECKEN_TOLERANZ;
  if (!((links || rechts) && (oben || unten))) return null;
  if (links && oben) return 'ol';
  if (rechts && oben) return 'or';
  if (links && unten) return 'ul';
  return 'ur';
}

/**
 * Halten zwei Griffe die ENDEN EINER DIAGONALE (ol+ur oder or+ul)? Nur dann
 * wird skaliert; zwei Finger an derselben Kante sollen weiter verschieben.
 *
 * Verglichen werden beide Buchstaben einzeln: `ol` und `ur` unterscheiden sich
 * in senkrechter UND waagerechter Lage, `ol` und `or` nur in einer.
 */
export function istDiagonale(a: Ecke | null, b: Ecke | null): boolean {
  if (!a || !b) return false;
  return a[0] !== b[0] && a[1] !== b[1];
}

/** Hält das Fenster vollständig im sichtbaren Bereich. */
export function einpassen(
  lage: Lage,
  groesse: Groesse,
  fenster: { innerWidth: number; innerHeight: number }
): Lage {
  const maxTop = Math.max(MARGIN, fenster.innerHeight - groesse.h - MARGIN);
  const maxLeft = Math.max(MARGIN, fenster.innerWidth - groesse.w - MARGIN);
  return {
    top: Math.min(Math.max(MARGIN, lage.top), maxTop),
    left: Math.min(Math.max(MARGIN, lage.left), maxLeft)
  };
}

/**
 * Neue Grösse aus dem Verhältnis der Fingerabstände — mit Untergrenze und mit
 * dem Bildschirm als Obergrenze. `startAbstand` wird gegen 1 abgesichert:
 * zwei Finger exakt aufeinander gäben sonst eine Division durch null.
 */
export function skalieren(
  start: Groesse,
  startAbstand: number,
  abstand: number,
  fenster: { innerWidth: number; innerHeight: number }
): Groesse {
  const faktor = abstand / Math.max(1, startAbstand);
  return {
    w: Math.max(MIN_W, Math.min(fenster.innerWidth - 2 * MARGIN, start.w * faktor)),
    h: Math.max(MIN_H, Math.min(fenster.innerHeight - 2 * MARGIN, start.h * faktor))
  };
}

/** Abstand zweier Punkte — als eigene Funktion, damit die Tests sie teilen. */
export function abstand(
  a: { x: number; y: number },
  b: { x: number; y: number }
): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}
