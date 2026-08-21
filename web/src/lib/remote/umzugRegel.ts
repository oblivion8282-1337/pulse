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

/**
 * Gilt der Umzug für DIESEN Server schon als erledigt?
 *
 * **Der Umzug läuft je Server**, nicht global — dasselbe Gerät kann in der
 * Cloud UND auf einem Self-Host eingetragen sein (`Freigegebener.serverId`),
 * und die lokale Freigabeliste trennt beide (Bughunt 2026-08-20, Fix-Runde 3:
 * ein fester, serverloser Merker liess den Umzug für den zweiten Server
 * dauerhaft ausfallen, sobald der erste erledigt war). Der Merker speichert
 * deshalb, WELCHE Server schon erledigt sind — eine Liste von Server-IDs.
 *
 * **Die alte Form (`true`) bleibt lesbar** und heisst „alles bisher Bekannte
 * erledigt": eine Maschine, die diesen Zweig schon mit dem einzelnen
 * Boolean-Merker durchlaufen hatte, soll dadurch nicht plötzlich für jeden
 * Server erneut umziehen.
 *
 * Importfrei, damit Nodes Testläufer sie laden kann.
 */
export function serverBereitsUmgezogen(merker: unknown, serverId: string): boolean {
  if (merker === true) return true;
  if (Array.isArray(merker)) return merker.includes(serverId);
  return false;
}
