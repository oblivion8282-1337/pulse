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
 *
 * **Zeitlimit (Befund 4, Bughunt 2026-08-29 Runde 6): `bereit` loest heute
 * NUR in `privateGruppen.svelte.ts::seed()` auf, und `ws/handlers/ready.ts`
 * ruft `gruppenApi.auflisten().then(seed).catch(() => undefined)` —
 * schlaegt der Abruf fehl, laeuft `seed()` nie und `bereit` bleibt fuer
 * immer offen. Ohne eigenes Zeitlimit haengt ein Gruppen-Direktlink dann
 * dauerhaft, ohne Fehler und ohne Meldung. Nach `zeitlimitMs` wird
 * `istGruppeBekannt()` trotzdem ein letztes Mal geprueft (nicht blind
 * `false` angenommen) — laeuft parallel doch noch eine Antwort ein, faengt
 * sie derselbe Weg wie im Erfolgsfall ab.
 */
export async function alsGruppeErkennenNachWarten(
  istGruppeBekannt: () => boolean,
  aufGruppenLadenWarten: () => Promise<void>,
  zeitlimitMs = 8000
): Promise<boolean> {
  await Promise.race([aufGruppenLadenWarten(), zeitlimitAblauf(zeitlimitMs)]);
  return istGruppeBekannt();
}

function zeitlimitAblauf(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
