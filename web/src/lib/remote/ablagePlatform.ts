/**
 * Ablage — Renderer zur Plattform-Brücke.
 *
 * Gebaut wie `sidecarInput.ts`: im Browser und in einer älteren Shell liefert
 * jede Funktion still ein Ergebnis, statt zu werfen. Der Unterschied zur
 * Eingabe ist die Bedeutung: eine verlorene Ablage-Nachricht kostet ein
 * Einfügen, keine Sitzung.
 *
 * **Zwei verschiedene Brücken, mit Absicht.** Hinaus geht jeder Rahmen über
 * `window.pulse.gsr.ablage(rolle, session, data)` — der Hauptprozess
 * entscheidet dort, ob er ins Player-Fenster oder an den Host-Sidecar geht
 * (`desktop/electron/ablageWeiche.ts`). Die **Rolle reist mit, statt im
 * Hauptprozess geraten zu werden**: ein Host, der nebenbei den Strom eines
 * Dritten im nativen Player anschaut, trägt ebenfalls eine Sitzungsnummer —
 * daraus liesse sich fälschlich 'controller' folgern. Der Renderer kennt
 * seine Rolle aus `remoteAblage.start(rolle, …)`. Herein kommt in diesem Plan
 * (1b-1) nur der Player-Weg: der native Player meldet einen lokal kopierten
 * Rahmen als `player:event`. Der Host-Sidecar meldet noch keinen — der
 * Sidecar-Op kommt erst in Plan 1b-2, deshalb hört [`aufAblageEreignisse`]
 * nur auf die Player-Brücke.
 */

function ablageBruecke() {
  return typeof window !== 'undefined' ? window.pulse?.gsr : undefined;
}

function playerBruecke() {
  return typeof window !== 'undefined' ? window.pulse?.player : undefined;
}

/** Einen Ablage-Wert an die eigene Plattform geben (Player beim Steuernden,
 *  Sidecar beim Host — die Weiche steht im Hauptprozess, `rolle` bestimmt sie,
 *  nicht `session`). `session` ist die Player-Fensternummer, sofern eine
 *  bekannt ist (0 sonst, s. `ablage.ts`).
 *
 *  `data` ist bereits eingehüllt (`ablageHuelle.ts`) — diese Funktion hüllt
 *  NICHT selbst ein: sie hat nur einen Parameter und könnte einen Anstoss von
 *  einem Leitungsrahmen nicht unterscheiden, also läge die Entscheidung wieder
 *  bei der Form des Werts statt beim Aufrufer, der sie kennt. */
export async function ablageAnPlayer(
  rolle: 'host' | 'controller',
  session: number,
  data: unknown,
): Promise<boolean> {
  const b = ablageBruecke();
  if (typeof b?.ablage !== 'function') return false;
  try {
    const antwort = (await b.ablage(rolle, session, data)) as { ok?: boolean } | undefined;
    return antwort?.ok === true;
  } catch {
    return false;
  }
}

/** Was die eigene Plattform hinausschicken will. Liefert den Abmelder, oder
 *  `null`, wenn es die Brücke nicht gibt. */
export function aufAblageEreignisse(cb: (data: unknown) => void): (() => void) | null {
  const b = playerBruecke();
  if (typeof b?.onEvent !== 'function') return null;
  return b.onEvent((ev: unknown) => {
    const m = ev as { ev?: unknown; data?: unknown } | null;
    if (m?.ev !== 'ablage') return;
    if (m.data === undefined) return;
    cb(m.data);
  });
}
