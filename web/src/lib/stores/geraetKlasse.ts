/**
 * Die eine Rechnung hinter der Frage „Desktop, Tablet oder Handy?" — und damit
 * der Vertrag, an dem sich jede Anordnung der Oberflaeche festmacht:
 *
 * **Die Klasse haengt am GERAET, nie an der Fensterbreite.** Entscheidend sind
 * nur drei Angaben: laeuft die Desktop-App (`electron`), ist der primaere
 * Zeiger ein Finger (`zeigerGrob`, `(pointer: coarse)`) und wie lang ist die
 * KURZE Bildschirmkante (`kurzeKante`, `min(width, height)`). Daraus folgt
 * genau eine von drei Klassen — die drei schliessen sich gegenseitig aus und
 * decken jeden Fall ab (Partition):
 *
 * * `desktop` — Desktop-App oder Maus-/Trackpad-Zeiger. So schmal das Fenster
 *   auch gezogen wird: die Desktop-Anordnung bleibt. Ein schmales Fenster ist
 *   ein kleines Desktop-Fenster, kein Handy.
 * * `handy` — Finger und kurze Kante unter 768 px. Gilt auch quer
 *   (844×390 bleibt ein Handy): ein Telefon hoert nicht auf, eins zu sein,
 *   weil es gedreht wurde.
 * * `tablet` — Finger und kurze Kante ab 768 px. grosse Fingerscreens mit
 *   Listen-und-Detail-Anordnung.
 *
 * Die Fensterbreite darf INNERHALB einer Klasse verkleinern (Spalten schrumpfen,
 * Listen blenden sich per CSS aus) — aber nie die Klasse wechseln. Wer auf
 * Klasse prueft, fragt den Store (`viewport.isMobile` / `isTablet` /
 * `isDesktop` / `istHandy`); wer per CSS-Breakpoint (`md:`/`lg:`) styled, darf
 * nur Groesse feinjustieren, nie die Anordnung einer anderen Klasse bauen.
 *
 * Importfrei (s. CLAUDE.md „Die Falle"), damit Nodes Testlaeufer die Rechnung
 * direkt pruefen kann: `pnpm test:unit`.
 */

export type GeraetKlasse = 'desktop' | 'tablet' | 'handy';

/** Die Schwelle der kurzen Kante zwischen Handy und Tablet (px). Dieselbe
 *  768 wie der `md`-Breakpoint — ein Portrait-Tablet beginnt dort, wo die
 *  Desktop-Spalten definitionsgemaess anfangen. */
export const HANDY_KANTE = 768;

export function geraetKlasse(
  electron: boolean,
  zeigerGrob: boolean,
  kurzeKante: number
): GeraetKlasse {
  if (electron || !zeigerGrob) return 'desktop';
  return kurzeKante < HANDY_KANTE ? 'handy' : 'tablet';
}
