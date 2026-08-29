/**
 * Reine Sichtbarkeits-Regeln fuer die beiden Kopplungs-Ansichten — importfrei
 * (s. CLAUDE.md „Die Falle"), damit sie ohne Svelte-Laufzeit pruefbar sind
 * (Bughunt 2026-08-29, Befunde 1 und 3).
 *
 * Die Kopplungs-Kennung und der Code bleiben im `$state` der jeweiligen
 * Komponente — der Code wandert NIRGENDS sonst hin (nicht `localStorage`,
 * kein Cookie, nicht ins Netz), das bleibt so. Hier steht nur, WANN ein
 * Knopf ueber einer laufenden Kopplung erscheint, nicht der Zustand selbst.
 */

/**
 * Zeigt-Seite (`KopplungZeigen.svelte`): der letzte Schiebe-Versuch ist an
 * einem Fehler gescheitert, die Kennung lebt aber noch im Speicher dieser
 * Sitzung — ein erneuter Versuch darf GENAU DIESE Kennung weiterverwenden
 * und trifft auf dem Server echte Vorarbeit (`verlaufSchieben` fragt den
 * Stand ab und schiebt nur die Differenz).
 *
 * **Grenze, absichtlich:** das gilt nur INNERHALB der laufenden Seite. Ein
 * vollstaendiges Neuladen verwirft den Code aus dem Speicher, und ohne ihn
 * laesst sich kein neues Stueck verschluesseln — dann bleibt nur ein neuer
 * Code am alten Geraet.
 */
export function kannErneutSchieben(
  kopplungId: string | null,
  fehler: string | null,
  fertig: boolean
): boolean {
  return kopplungId !== null && fehler !== null && !fertig;
}

/**
 * Einloesen-Seite (`KopplungEinloesen.svelte`): solange eine Kopplung laeuft
 * und noch nichts uebernommen ist, braucht der Nutzer einen Weg zurueck —
 * sonst haengt er, wenn der Sender abbricht, auf einer toten Kennung fest
 * und muss die ganze Seite neu laden.
 */
export function kannVerwerfen(kopplungId: string | null, uebernommen: number | null): boolean {
  return kopplungId !== null && uebernommen === null;
}
