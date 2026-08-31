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
 * stirbt sein Prozess. **Auf macOS stirbt er nicht** (s. `traegerWechsel`).
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

/**
 * Wer trägt künftig — und **wem muss vorher gesagt werden, dass er es nicht
 * mehr tut**.
 *
 * Der zweite Teil ist neu und existiert wegen macOS. Bis Plan 1b-2 galt: dem
 * alten Träger wird nichts geschickt, sein Prozess beendet sich nach `stop`
 * selbst (`win-hq-sidecar/src/dispatch.rs`), und ein Auftrag an ihn startete
 * einen frischen Prozess, nur um ihm zu sagen, dass er nichts zu tun hat.
 *
 * **Der mac-Sidecar bleibt über Streams hinweg warm** (`mac-hq-sidecar/
 * src/dispatch.rs`: kein `exit_after`). Endet dort der Träger-Stream, läuft
 * sein Prozess weiter — und hält die Zwischenablage des Nutzers weiter
 * beansprucht, also leer, bis die ganze App endet. Er braucht sein `ende`.
 *
 * **Die Plattform wird hier trotzdem nicht abgefragt, und das ist Absicht.**
 * Der Hauptprozess schickt das `ende` nur an einen Platz, dessen Sidecar noch
 * läuft (`sidecarRunning`) — und genau diese Frage IST der Unterschied
 * zwischen den beiden Plattformen: auf Windows ist der alte Prozess weg, der
 * Riegel greift, und es bleibt beim bisherigen Verhalten; auf macOS lebt er,
 * und er bekommt sein `ende`. Ein `process.platform`-Zweig wäre eine zweite
 * Behauptung über dieselbe Sache, und die eine davon könnte falsch werden.
 *
 * `abzumelden` ist auch dann gesetzt, wenn niemand nachfolgt (letzter Stream
 * beendet): gerade dann bliebe die Ablage sonst bis zum App-Ende belegt.
 */
export function traegerWechsel(
  laufende: readonly number[],
  bisher: number | null,
): { traeger: number | null; abzumelden: number | null } {
  const traeger = traegerWaehlen(laufende, bisher);
  if (traeger === bisher) return { traeger, abzumelden: null };
  return { traeger, abzumelden: bisher };
}
