/**
 * HH:MM-Uhrzeit für Chat-Zeilen (Stream-Chat-Panel, Watch-Party-Chat).
 * Bewusst simpel: keine Relativdaten, kein Datum — nur die Uhrzeit, wie
 * sie der Server-`created_at` direkt hergibt. Müll/ungültig → ''.
 * Importfrei, damit Tests die Datei direkt prüfen können.
 * `locale` nachlegen (Bughunt Runde 14): App-Sprache statt System-Sprache.
 */
export function uhrzeitHHMM(iso: string, locale?: string): string {
  try {
    return new Date(iso).toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return '';
  }
}
