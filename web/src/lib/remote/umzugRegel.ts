/**
 * Soll die alte gerätelokale Freigabeliste jetzt auf den Server geschoben
 * werden?
 *
 * Reine Entscheidung, kein Netz, kein Zustand — die Netzwerkfrage „ist die
 * Server-Liste leer" beantwortet der Aufrufer vorher (`standplatz.svelte.ts`,
 * `freigaben.laden`/`freigaben.fuer`).
 *
 * `freigaben.setzen()` (`$lib/devices/freigaben.svelte.ts`) ist PUT-Semantik
 * und ersetzt die GANZE Server-Liste. Ein Umzug, der eine dort schon
 * gepflegte Liste überschreibt, wäre ein Datenverlust — deshalb zieht diese
 * Regel nur um, wenn die Server-Liste LEER ist. Ist sie es nicht, gilt der
 * Umzug als erledigt (der Aufrufer setzt den Merker, ohne etwas zu senden):
 * jemand hat die Freigaben auf dem Server bereits von Hand gepflegt, und die
 * lokale Liste ist damit veraltet, nicht massgeblich.
 *
 * Importfrei, damit Nodes Testläufer sie laden kann.
 */
export function umziehenNoetig(s: {
  /** Gibt es lokal überhaupt etwas umzuziehen? */
  lokalVorhanden: boolean;
  /** Steht auf dem Server (für dieses Gerät) noch keine einzige Freigabe? */
  serverListeLeer: boolean;
  /** Ist der Umzug schon einmal gelungen (Merker gesetzt)? */
  bereitsUmgezogen: boolean;
}): boolean {
  return s.lokalVorhanden && s.serverListeLeer && !s.bereitsUmgezogen;
}
