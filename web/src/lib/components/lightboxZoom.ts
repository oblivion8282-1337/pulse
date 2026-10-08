/**
 * Die Rechnung hinter Pinch- und Doppeltipp-Zoom der Lightbox.
 *
 * Importfrei, damit Nodes Testläufer sie prüfen kann (s. `pnpm test:unit`-
 * Falle im CLAUDE.md); die Gesten-Verdrahtung steht in `Lightbox.svelte`.
 *
 * **Koordinaten sind Bildschirm-Pixel relativ zur Bildfläche**, die
 * Verschiebung (`dx`/`dy`) ist die des bereits SKALIERTEN Bildes — genau das,
 * was `transform: translate(...) scale(...)` erwartet. Wer hier in
 * Bild-Koordinaten rechnet, bekommt beim Zoomen einen Versatz, der mit der
 * Skala wächst.
 */

/** Weiter als 4× wird aus einem Chat-Bild nur noch Matsch. */
export const MAX_SKALA = 4;

export interface Zoomstand {
  skala: number;
  dx: number;
  dy: number;
}

export const ZOOM_AUS: Zoomstand = { skala: 1, dx: 0, dy: 0 };

export function begrenzeSkala(skala: number): number {
  if (!Number.isFinite(skala) || skala < 1) return 1;
  return Math.min(skala, MAX_SKALA);
}

/**
 * Wie weit das skalierte Bild höchstens verschoben werden darf, damit keine
 * leere Fläche in den Rahmen rutscht: bei Skala `s` ragt es auf jeder Seite
 * um `(s-1)/2` der Kantenlänge über.
 */
export function maxVerschiebung(skala: number, kante: number): number {
  return Math.max(0, ((begrenzeSkala(skala) - 1) * kante) / 2);
}

/** `Math.max(-0, …)` liefert negative Null, und die reist dann durch den
 *  ganzen Zustand. Sichtbar wird sie nirgends (CSS rechnet `-0px` wie `0px`),
 *  aber sie macht jeden Vergleich auf Gleichheit zur Falle — ein Test, der
 *  `{dy: 0}` erwartet, scheitert an `{dy: -0}`. Hier einmal glattziehen. */
function ohneMinusNull(n: number): number {
  return n === 0 ? 0 : n;
}

export function begrenzeStand(stand: Zoomstand, breite: number, hoehe: number): Zoomstand {
  const skala = begrenzeSkala(stand.skala);
  const gx = maxVerschiebung(skala, breite);
  const gy = maxVerschiebung(skala, hoehe);
  return {
    skala,
    dx: ohneMinusNull(Math.min(gx, Math.max(-gx, stand.dx))),
    dy: ohneMinusNull(Math.min(gy, Math.max(-gy, stand.dy)))
  };
}

/**
 * Doppeltipp: aus der Ruhelage auf 2×, aus jedem gezoomten Zustand zurück auf
 * 1×. Bewusst KEIN Durchschalten 1→2→4: der zweite Doppeltipp soll
 * verlässlich wieder herauszoomen, nicht weiter hinein.
 */
export function doppeltippStand(aktuell: Zoomstand): Zoomstand {
  if (aktuell.skala > 1) return { ...ZOOM_AUS };
  return { skala: 2, dx: 0, dy: 0 };
}

/**
 * Pinch: neue Skala aus dem Verhältnis der Fingerabstände, und die
 * Verschiebung so nachgeführt, dass der Punkt ZWISCHEN den Fingern stehen
 * bleibt. Ohne diese Nachführung zoomt das Bild immer zur Mitte, und das
 * fühlt sich an, als rutschte es unter dem Finger weg.
 *
 * `mx`/`my` ist der Mittelpunkt der Finger, gemessen von der MITTE der
 * Bildfläche aus (links/oben negativ).
 */
export function pinchStand(
  start: Zoomstand,
  faktor: number,
  mx: number,
  my: number
): Zoomstand {
  const skala = begrenzeSkala(start.skala * faktor);
  // Tatsächliches Verhältnis nach der Begrenzung — sonst wandert die
  // Verschiebung weiter, obwohl die Skala längst an der Grenze steht.
  const wirklich = skala / start.skala;
  return {
    skala,
    dx: mx - (mx - start.dx) * wirklich,
    dy: my - (my - start.dy) * wirklich
  };
}
