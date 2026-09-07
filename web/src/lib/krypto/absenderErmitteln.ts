/**
 * Wer eine geoeffnete Postfach-Zustellung geschrieben hat — importfrei
 * (s. `pnpm test:unit`-Falle in `CLAUDE.md`), damit `empfangen.ts` diese
 * eine Rechnung nicht in einer `$state()`-tragenden Datei verstecken muss.
 *
 * Der Server liefert `absender_user_id` aus der Nutzlast-Zeile selbst
 * (`postfach_abholen.py`; bis 2026-09-07 war es ein Join ueber die
 * Geraetekennung, der bei doppelt gefuehrter Kennung die falsche Antwort
 * geben konnte) — der Klient kann es NICHT selbst bestimmen: er
 * kennt zu einer Zustellung nur den Kanal, und eine verschluesselte DM
 * liefert auch an die EIGENEN anderen Geraete des Senders aus (so kommt
 * eine vom Handy gesendete Nachricht auf dem Desktop an). „Der andere
 * Kanal-Teilnehmer" waere in genau diesem Fall die FALSCHE Zuschreibung.
 *
 * `absenderUserId` ist `null` bei Zustellungen von vor Migration 0076, die
 * die Spalte noch nicht tragen (laengstens bis zum Ablauf ihrer Frist)
 * — in dem Fall faellt diese Funktion auf `kanalGegenpart` zurueck, das
 * bisherige Verhalten vor diesem Feld. Bei einer DM ist der Kanal-Gegenpart
 * meist richtig, aber genau dann falsch, wenn die Zustellung vom eigenen
 * anderen Geraet kam; eine private Gruppe hat keinen einzelnen Gegenpart und
 * uebergibt hier `undefined`.
 */
export function absenderErmitteln(
  absenderUserId: string | null | undefined,
  kanalGegenpart: string | null | undefined
): string | null {
  return absenderUserId ?? kanalGegenpart ?? null;
}
