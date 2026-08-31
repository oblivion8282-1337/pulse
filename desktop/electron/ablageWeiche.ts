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

/** Welcher Prozess die lokale Zwischenablage dieser Rolle hält. */
export function zielFuerAblage(rolle: 'host' | 'controller'): 'player' | 'sidecar' {
  return rolle === 'controller' ? 'player' : 'sidecar';
}
