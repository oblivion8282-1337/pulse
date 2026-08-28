/**
 * Welcher Anmeldeweg gilt für einen Server — Ticket oder Zertifikat.
 *
 * **Importfrei mit Absicht.** Die Datei wird von `pnpm test:unit` unter Nodes
 * eigenem Läufer geprüft, und der löst erweiterungslose Importe nicht auf
 * (Muster: `lib/navigation/tabs.ts`, `lib/stream/monitorZuordnung.ts`). Die
 * Rechnung steht deshalb allein hier, ohne einen einzigen Import.
 *
 * **Fähigkeit statt Version.** Die Web-App kommt von der Cloud und ist für alle
 * sofort neu — auch für Electron, das die deployte App remote lädt. Ein
 * Self-Host aktualisiert sich dagegen über seinen eigenen Zeitgeber, wann er
 * will. Eine neue App trifft deshalb wochenlang auf alte Server. Wer hier
 * Versionen vergliche, müsste raten; die Fähigkeitsliste im `hello`-Rahmen
 * sagt es.
 */

export type Anmeldeweg = 'ticket' | 'zertifikat';

/**
 * Die Fähigkeit, an der der Ticket-Weg hängt.
 *
 * Muss mit `services/chat-gateway/src/dcc_chat_gateway/routes/ws.py`
 * übereinstimmen. Ein Tippfehler fällt sonst nicht auf: Der Rückfall auf den
 * Zertifikats-Weg sieht völlig normal aus, und niemand bekäme je den neuen.
 */
export const FAEHIGKEIT_TICKET = 'server-ticket';

/**
 * Entscheidet aus den angekündigten Fähigkeiten, welcher Weg gilt.
 *
 * Ohne Auskunft (vor dem ersten `hello`) gilt der Zertifikats-Weg: Er
 * funktioniert auf jedem Server, der neue nur auf neuen. Im Zweifel also der,
 * der immer geht.
 */
export function waehleAnmeldeweg(
  faehigkeiten: readonly string[] | null | undefined,
): Anmeldeweg {
  return faehigkeiten?.includes(FAEHIGKEIT_TICKET) ? 'ticket' : 'zertifikat';
}
