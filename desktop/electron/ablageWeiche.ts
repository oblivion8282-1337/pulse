/**
 * Wohin ein Ablage-Rahmen im Hauptprozess geht.
 *
 * **Die Weiche steht hier und nicht im Renderer**, aus demselben Grund wie bei
 * `input_capture`: sie ist eine Zuordnung zwischen Prozessen, und die gehört
 * dem Hauptprozess. Der Renderer kennt die Rolle, nicht die Prozesse.
 *
 * Der Unterschied ist keine Feinheit: **beim Steuernden läuft überhaupt kein
 * Sidecar** — dort ist nur das Player-Fenster offen. Beim Host ist es
 * umgekehrt.
 *
 * Eigene Datei und importfrei, damit `pnpm test:unit` sie fahren kann.
 */

/**
 * Der Anstoss „deine Ablage-Sitzung ist vorbei" — Eigentum abgeben und den
 * gemerkten Vorbestand des Nutzers zurückschreiben.
 *
 * **Steht hier, weil ihn ZWEI Stellen im Hauptprozess schicken**: das
 * Aufräumen nach einem Renderer-Neuladen und der Trägerwechsel
 * (`gsr:ablageEnde`). Als Literal an beiden Stellen wäre er eine Behauptung,
 * die an einer davon veralten kann; die Hülle selbst gehört
 * `$lib/remote/ablageHuelle.ts`, und das ist genau die Datei, die der
 * Hauptprozess nicht importieren kann.
 */
export function endeAnstoss(): { anstoss: 'ende' } {
  return { anstoss: 'ende' };
}

/** Welcher Prozess die lokale Zwischenablage dieser Rolle hält. */
export function zielFuerAblage(rolle: 'host' | 'controller'): 'player' | 'sidecar' {
  return rolle === 'controller' ? 'player' : 'sidecar';
}

/**
 * Die Rolle, wie sie über IPC hereinkommt. Alles, was nicht genau eine der
 * beiden Rollen ist, wird abgewiesen — fail-closed wie im ganzen
 * Fernsteuerungs-Weg. Geraten wird hier NICHT: der Renderer kennt seine
 * Rolle, und eine erschlossene wäre bei einem Host mit offenem Fremd-Player
 * falsch (er trägt dann ebenfalls eine Sitzungsnummer > 0).
 *
 * **Warum eine renderer-gelieferte Rolle hier zulässig ist**, obwohl
 * `input_capture` seine Zuordnung bewusst im Hauptprozess hält:
 * `input_capture` autorisiert eine Eingabe-Injektion — das ist eine
 * Sicherheitsentscheidung. Diese Weiche entscheidet nur, welcher der
 * EIGENEN lokalen Prozesse die Ablage hält; eine falsche Rolle kostet ein
 * fehlgeleitetes Einfügen, keine Befugnis.
 */
export function rolleLesen(roh: unknown): 'host' | 'controller' | null {
  return roh === 'host' || roh === 'controller' ? roh : null;
}
