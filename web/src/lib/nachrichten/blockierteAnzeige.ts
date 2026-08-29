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
 * **Geltungsbereich (Bughunt 2026-08-29, Befund 1): nur DMs und private
 * Gruppen, NICHT Community-Kanaele.** Blockieren kennt server-seitig nur
 * diese beiden (`block_exists_either_way` steht in `routes/messages.py` und
 * `routes/ws_op_send.py` ausschliesslich im DM-Zweig; in einem
 * Gilden-/Community-Kanal wird nie auf Blockade geprueft). Die erste Fassung
 * dieser Funktion las den Autor ohne jede Pruefung der Kanalart und klappte
 * damit Nachrichten blockierter Mitglieder auch in gewoehnlichen
 * Community-Kanaelen zusammen — ungewollt, weder Commit noch Kommentar
 * nannten das. `istDirekt` ist deshalb Pflicht, nicht optional: der Aufrufer
 * (`MessageItem.svelte`) uebergibt dieselbe Kanal-Unterscheidung, die auch
 * die Sprechblasen-Huelle gated (`layout === 'bubble'`) — DMs UND private
 * Gruppen fuehren beide kein `guild_id`.
 *
 * Im DM-Weg greift der Block schon in der Zustellung (dort kommt gar nichts
 * an), die Rechnung hier ist dort also nur nie erfuellt, nicht falsch.
 */
export function nachrichtVonBlockiertem(
  autorId: string,
  blockierteIds: ReadonlySet<string>,
  istDirekt: boolean
): boolean {
  return istDirekt && blockierteIds.has(autorId);
}
