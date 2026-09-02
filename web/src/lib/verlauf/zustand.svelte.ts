/**
 * Sichtbarer Zustand des lokalen Verlaufs — WARUM er gerade nicht (mehr)
 * lokal liegt, nicht nur DASS er es nicht tut. Nutzt `$state`, s. Warnung in
 * `speicherfehler.ts` (die geprüfte Klassifizierung liegt deshalb dort).
 */
import { deuteSpeicherfehler, type SpeicherLage } from './speicherfehler';

/** Ein Satz je Lage — `was_tun` nur bei `voll`, s. Tabelle in Plan Task 1. */
const GRUND_TEXT: Record<SpeicherLage, string> = {
  nicht_verfuegbar:
    'Verlauf läuft nur online — der private Modus blockt den lokalen Speicher.',
  voll: 'Lokaler Speicher ist voll. Ältere Verläufe lassen sich in den Einstellungen freigeben.',
  fehler: 'Lokaler Verlauf ist gerade nicht verfügbar.'
};

class VerlaufZustand {
  verfuegbar = $state(true);
  grund = $state<string | null>(null);

  /**
   * Ein fehlgeschlagener lokaler Lese-/Schreibversuch. Setzt den Grund nur
   * EINMAL — bei jedem weiteren Fehlschlag flackerte sonst der Hinweis
   * (verschiedene Ursachen könnten sich sonst gegenseitig überschreiben,
   * ohne dass der Nutzer je die erste Erklärung sieht).
   *
   * **Der App bleibt in jedem Fall benutzbar** — dies setzt nur die
   * Erklärung, der Rückfall auf den Server passiert an der Aufrufstelle
   * (`verlauf/index.ts`), nicht hier.
   */
  melde(err: unknown): void {
    if (!this.verfuegbar) return;
    const { art } = deuteSpeicherfehler(err);
    this.verfuegbar = false;
    this.grund = GRUND_TEXT[art];
  }
}

export const verlaufZustand = new VerlaufZustand();
