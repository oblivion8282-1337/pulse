/**
 * Ob eine Nachricht von jemandem stammt, den der Betrachter blockiert hat —
 * importfrei, damit Nodes Testlaeufer sie sieht (s. CLAUDE.md-Falle zu
 * `pnpm test:unit`).
 *
 * Anlass (Bughunt 2026-08-28): der Server stellt eine private
 * Gruppennachricht eines geblockten Absenders bewusst zu — die Begruendung
 * in `_postfach_deps.py` verweist ausdruecklich auf die Anzeige, die das
 * Ausblenden uebernehmen soll. Diese Rechnung ist dieses Ausblenden; die
 * Huelle (`MessageItem.svelte`) entscheidet damit, ob sie eine Nachricht
 * offen zeigt oder zusammengeklappt hinter einem Hinweis versteckt.
 *
 * Gilt fuer JEDE Nachrichtenquelle (Community-Kanal, private Gruppe, DM) —
 * im DM-Weg greift der Block schon in der Zustellung (dort kommt gar nichts
 * an), die Rechnung hier ist dort also nur nie erfuellt, nicht falsch.
 */
export function nachrichtVonBlockiertem(
  autorId: string,
  blockierteIds: ReadonlySet<string>
): boolean {
  return blockierteIds.has(autorId);
}
