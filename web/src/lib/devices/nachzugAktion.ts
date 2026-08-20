/**
 * Was passiert mit der lokalen Eintragung, wenn eine `device_changed`-Meldung
 * hereinkommt?
 *
 * Reine Entscheidung, importfrei für Nodes Testläufer — die eigentliche
 * Umsetzung (räumen/nachziehen/schreiben) bleibt in `anmeldung.svelte.ts`,
 * die Verzweigung liegt im WS-Handler (`ws/handlers/devices.ts`).
 *
 * **Die Pointe:** `device_changed` kommt bei JEDEM Gerätewechsel im selben
 * Kanal herein, nicht nur beim eigenen. Ohne `hatEintragung` als erste,
 * unbedingte Prüfung würde eine Meldung über ein FREMDES Gerät diesen
 * Rechner zu einem Gerät machen, das er nie eingetragen hat — genau die
 * Fehlerform, an der dieser Umbau schon dreimal gescheitert ist (Code, der
 * gut aussieht, aber im falschen Fall trotzdem greift).
 */
export type NachzugAktion = 'nichts' | 'vergessen' | 'nachziehen';

export function nachzugAktion(s: {
  /** Gibt es überhaupt eine lokale Eintragung mit dieser Gerätekennung? */
  hatEintragung: boolean;
  /** Trägt die Meldung `removed: true`? */
  entfernt: boolean;
  /** Stimmen Community UND Name der Meldung schon mit der Eintragung überein? */
  unveraendert: boolean;
}): NachzugAktion {
  if (!s.hatEintragung) return 'nichts';
  if (s.entfernt) return 'vergessen';
  return s.unveraendert ? 'nichts' : 'nachziehen';
}
