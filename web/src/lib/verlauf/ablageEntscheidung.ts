/**
 * Reine Entscheidung: gilt ein Community-Kanal als lokal gefuehrter
 * Ablage-Kanal? Ausgelagert aus `index.ts::istAblageKanal`, damit die Weiche
 * selbst pruefbar ist — `index.ts` haengt an den Rune-Speichern (`guilds`)
 * und ist im Node-Testlaeufer nicht ladbar (CLAUDE.md „Die Falle").
 *
 * Hinter dem Schalter: ist `enabled` (`ABLAGE_KANAL_ENABLED`) aus, bleibt
 * die Antwort fuer JEDEN Kanal `false` — der Schalter ist ein Schalter,
 * kein Versteck.
 */
export function brauchtLokalenVerlauf(
  enabled: boolean,
  channel: { ablage?: boolean } | null | undefined
): boolean {
  return enabled && !!channel?.ablage;
}
