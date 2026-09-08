/**
 * Die Rechnung hinter Swipe-to-reply (P1.6) — importfrei, damit der
 * eingebaute Testlauf sie ohne Browser prüft (Repo-Muster, s.
 * `stores/lesestandKern.ts`).
 *
 * WhatsApp-Semantik, horizontal: die Blase wandert in Richtung des Zugs,
 * ab der Schwelle wird die Antwort „geladen". Vertikal dominierende Bewegung
 * ist Scrollen und darf den Zustand nie anfassen.
 */

/** Ab wie vielen Pixeln der Zug die Antwort auslöst. */
export const ANTWORT_SCHWELLE = 48;
/** Wie weit die Blase maximal wandert (visuelles Kappmaß). */
export const OFFSET_KAPPMASS = 56;

/**
 * Führt ein horizontaler Zug? Nur wenn er deutlich horizontal ist —
 * sonst ist es Scrollen (die Liste ist virtuell und vertical-first).
 */
export function fuehrtZuAntwort(dx: number, dy: number): boolean {
  return Math.abs(dx) > 24 && Math.abs(dx) > Math.abs(dy) * 1.4;
}

/** Angezeigter Blasen-Versatz: gekappt, damit die Blase nie wegfliegt. */
export function klemmeOffset(dx: number): number {
  if (dx > OFFSET_KAPPMASS) return OFFSET_KAPPMASS;
  if (dx < -OFFSET_KAPPMASS) return -OFFSET_KAPPMASS;
  return dx;
}

/** Deckkraft des Antwort-Pfeils aus dem Versatz — 0 bis zur Schwelle,
 *  dann voll. Der Pfeil sitzt an der Zug-Gegenseite (Vorzeichen entscheidet). */
export function pfeilDeckkraft(offset: number): number {
  const betrag = Math.abs(offset) / ANTWORT_SCHWELLE;
  return Math.min(1, Math.max(0, betrag));
}
