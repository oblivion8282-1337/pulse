/**
 * Reine Rechnung: wer ist die DM-Gegenstelle einer verschluesselten
 * Nachricht, fuer den DM-Listen-Bump — importfrei (s. CLAUDE.md „Die
 * Falle"), damit `ws/handlers/chat.ts` diese eine Rechnung nicht in einer
 * `$state()`-tragenden Datei verstecken muss.
 *
 * Bughunt 2026-08-28, FIX 3: der `postfach_neu`-Weckruf traegt bewusst
 * keinen Inhalt (Spec §4), die Gegenstelle muss deshalb aus der bereits
 * entschluesselten Nachricht hergeleitet werden. Ist der Absender man
 * selbst (eigenes anderes Geraet schrieb die Nachricht), bleibt nur der
 * schon bekannte Kanal-Gegenpart als Rueckfall — ist der (noch) unbekannt
 * (druckfrische DM, noch kein Kanal-Eintrag lokal), gibt es keine
 * bestimmbare Gegenstelle: der Aufrufer laesst den Bump dann aus, der
 * naechste hydrate/ready-Rahmen holt den Kanal ohnehin nach.
 */
export function dmGegenstelle(
  autorId: string,
  eigeneUserId: string,
  bekannterKanalGegenpart: string | undefined
): string | null {
  if (autorId !== eigeneUserId) return autorId;
  return bekannterKanalGegenpart ?? null;
}
