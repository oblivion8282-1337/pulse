/**
 * Wer eine geoeffnete Postfach-Zustellung geschrieben hat — importfrei
 * (s. `pnpm test:unit`-Falle in `CLAUDE.md`), damit `empfangen.ts` diese
 * eine Rechnung nicht in einer `$state()`-tragenden Datei verstecken muss.
 *
 * Der Server liefert `absender_user_id` als hergeleitetes Feld (join
 * `DeviceKeyBundle` ueber `absender_device_pubkey`,
 * `postfach_abholen.py`) — der Klient kann es NICHT selbst bestimmen: er
 * kennt zu einer Zustellung nur den Kanal, und eine verschluesselte DM
 * liefert auch an die EIGENEN anderen Geraete des Senders aus (so kommt
 * eine vom Handy gesendete Nachricht auf dem Desktop an). „Der andere
 * Kanal-Teilnehmer" waere in genau diesem Fall die FALSCHE Zuschreibung.
 *
 * `absenderUserId` ist `null`, wenn sich das Sendegeraet zwischen
 * Einliefern und Abholen abgemeldet und sein Schluessel-Buendel damit
 * geloescht hat (der Server kann dann nicht mehr nachschlagen, wer es war)
 * — in dem Fall faellt diese Funktion auf `kanalGegenpart` zurueck, das
 * bisherige Verhalten vor diesem Feld. Bei einer DM ist der Kanal-Gegenpart
 * fast immer richtig (das seltene Eigengeraet-ohne-Buendel-Fenster
 * ausgenommen); eine private Gruppe hat keinen einzelnen Gegenpart und
 * uebergibt hier `undefined`.
 */
export function absenderErmitteln(
  absenderUserId: string | null | undefined,
  kanalGegenpart: string | null | undefined
): string | null {
  return absenderUserId ?? kanalGegenpart ?? null;
}
