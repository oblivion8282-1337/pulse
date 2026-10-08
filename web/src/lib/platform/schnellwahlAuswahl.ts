/**
 * Welche Gespräche in der Schnellwahl am App-Symbol stehen (iOS-Punkt 44).
 *
 * **Warum das eine eigene, geprüfte Rechnung ist:** es sind drei
 * Entscheidungen, und zwei davon sind Zurückhaltung.
 *
 *  1. **Höchstens `MAX_EINTRAEGE`.** iOS zeigt vier Plätze; wir nehmen drei
 *     und lassen Luft — die Liste soll ein Sprung sein, keine zweite
 *     Chat-Übersicht. Wer mehr sucht, öffnet die App.
 *  2. **Nur Gespräche MIT Namen.** Der Name kommt aus dem Nutzer-Cache, und
 *     der ist beim Start kurz leer. Ein Platz mit einer Zahl oder „…" darauf
 *     wäre schlechter als ein Platz weniger — die Schnellwahl überdauert den
 *     Neustart, ein halb gefüllter Eintrag bliebe also stehen.
 *  3. **Nur Gespräche, in denen schon etwas steht.** Eine frisch angelegte,
 *     leere DM ist kein „letztes Gespräch". Die Reihenfolge der Eingabe wird
 *     ÜBERNOMMEN, nicht neu sortiert: sie kommt aus `directMessages.list`
 *     („zuletzt aktiv zuerst"), und eine zweite Sortierung hier wäre eine
 *     zweite Wahrheit über dieselbe Frage.
 *
 * Importfrei und damit prüfbar (s. die `pnpm test:unit`-Falle in CLAUDE.md).
 */

export const MAX_EINTRAEGE = 3;

export interface Gespraech {
  /** Kanal-Kennung (Snowflake als String). */
  id: string;
  /** Gegenstelle — nur für die Namensauflösung. */
  other_user_id: string;
  /** `null` = noch keine Nachricht. */
  last_message_id: string | null;
}

export interface Eintrag {
  titel: string;
  pfad: string;
}

/**
 * `namen` bildet `other_user_id` auf den Anzeigenamen ab; fehlt einer, fällt
 * das Gespräch heraus (Regel 2).
 */
export function schnellwahlEintraege(
  gespraeche: readonly Gespraech[],
  namen: Record<string, string | undefined>
): Eintrag[] {
  const fertig: Eintrag[] = [];
  for (const g of gespraeche) {
    if (fertig.length >= MAX_EINTRAEGE) break;
    if (!g.last_message_id) continue;
    const titel = namen[g.other_user_id]?.trim();
    if (!titel) continue;
    fertig.push({ titel, pfad: `/app/@me/${g.id}` });
  }
  return fertig;
}
