/**
 * Ob eine noch unbekannte Kanal-ID nach dem Gruppen-Ladevorgang eine private
 * Gruppe ist (Bughunt 2026-08-29, Gruppen-Direktlink).
 *
 * **Importfrei** (s. CLAUDE.md „Die Falle") — `+page.svelte::switchTo` kann
 * dieses Modul nicht direkt pruefen (Rune-Huelle im Aufrufer), die
 * Entscheidung selbst schon: sie braucht nur eine Abfrage und ein Warten,
 * keine Runen.
 *
 * **Warum das Warten noetig ist:** anders als DMs steht der Gruppen-Bestand
 * nicht im `ready`-Rahmen, sondern kommt ueber ein eigenes, NICHT
 * abgewartetes `GET /gruppen` (`stores/privateGruppen.svelte.ts`). Ein
 * Direktlink/harter Reload auf eine Gruppen-ID, aufgerufen bevor diese
 * Antwort da ist, faende die Gruppe noch nicht — ohne dieses Warten haelt
 * `switchTo` sie faelschlich fuer eine DM und scheitert am DM-Abruf.
 *
 * Wird nur gerufen, wenn `cid` weder als Gruppe noch als DM bekannt ist —
 * der Aufrufer gated das selbst, damit der ueberwiegende (bereits bekannte)
 * Fall gar nicht erst hier ankommt und keinen Umweg nimmt.
 */
export async function alsGruppeErkennenNachWarten(
  istGruppeBekannt: () => boolean,
  aufGruppenLadenWarten: () => Promise<void>
): Promise<boolean> {
  await aufGruppenLadenWarten();
  return istGruppeBekannt();
}
