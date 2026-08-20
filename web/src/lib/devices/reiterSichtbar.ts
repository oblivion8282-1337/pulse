/**
 * Zeigt dieser Client den Standplatz-Reiter?
 *
 * **Nicht dieselbe Frage wie `darfStandplatzSein()`** — die beantwortet „kann
 * dieser RECHNER Standplatz sein" und hängt an der Anmeldung
 * (`ws/handlers/ready.ts`) und der Übernahme (`remote/session.svelte.ts`). Die
 * beiden liefen am 2026-08-18 schon einmal auseinander: der Reiter war unter
 * Linux versteckt, die vorhandene Eintragung meldete sich trotzdem weiter an.
 * Deshalb steht die Reiter-Regel hier und fasst jene nicht an.
 *
 * Importfrei für Nodes Testläufer.
 */
export function reiterSichtbar(s: {
  kannStandplatzSein: boolean;
  hatEintragung: boolean;
  besitztGeraete: boolean;
}): boolean {
  return s.kannStandplatzSein || s.hatEintragung || s.besitztGeraete;
}
