/**
 * Wer von mehreren Sidecar-Prozessen die Zwischenablage hält.
 *
 * **Warum das überhaupt eine Frage ist:** Windows fährt je Stream-Platz einen
 * eigenen Sidecar-Prozess (`desktop/electron/sidecar.ts::getSidecar(slot)`),
 * die Zwischenablage ist aber maschinenweit. Beanspruchten alle drei Prozesse
 * eines Drei-Monitor-Streams sie, überschrieben sie sich gegenseitig — jeder
 * Anspruch verdrängt den vorigen, und der Vorbestand des Nutzers stünde
 * dazwischen.
 *
 * **Gewählt wird hier, weil hier die Plätze zusammenlaufen.** Das ist wörtlich
 * dieselbe Auflösung wie beim Vorrang (`vorrang.ts`): die Wache sitzt dort
 * ebenfalls je Prozess, und nur der Renderer kennt alle Plätze. Der gewählte
 * Prozess bekommt den Anstoss `beginn` und stellt daraufhin seinen
 * Fensterfaden auf; die übrigen rühren die Ablage nie an.
 *
 * **Importfrei mit Absicht** — `pnpm test:unit` fährt Nodes eingebauten Läufer,
 * und der löst einen erweiterungslosen Laufzeit-Import nicht auf.
 */

/**
 * Wer trägt? `null` heisst „niemand" (kein Stream läuft).
 *
 * **Der bisherige Träger bleibt es, solange sein Stream läuft.** Ein Wechsel
 * ist nicht gratis: der neue Prozess beginnt mit einer eigenen
 * Generationszählung bei null, die Gegenseite hält bis zu ihrer nächsten
 * Ankündigung eine Nummer, die hier niemand mehr kennt, und der Vorbestand des
 * Nutzers wandert durch eine Freigabe. Gewechselt wird deshalb **nur, wenn es
 * sein muss** — und das ist genau der Fall, den `dispatch.rs` erzwingt: der
 * Windows-Sidecar beendet sich nach `stop`, endet also der Träger-Stream,
 * stirbt sein Prozess.
 *
 * Kommen mehrere in Frage, gewinnt der kleinste Platz. Welcher es ist, ist
 * gleichgültig — festgelegt wird es trotzdem, damit zwei Aufrufe im selben
 * Zustand dieselbe Antwort geben.
 */
export function traegerWaehlen(
  laufende: readonly number[],
  bisher: number | null,
): number | null {
  if (bisher !== null && laufende.includes(bisher)) return bisher;
  let kleinster: number | null = null;
  for (const platz of laufende) {
    if (!Number.isInteger(platz) || platz < 0) continue;
    if (kleinster === null || platz < kleinster) kleinster = platz;
  }
  return kleinster;
}
