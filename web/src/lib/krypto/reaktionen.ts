/**
 * Reaktionen auf Ende-zu-Ende-verschluesselte Nachrichten — die Rechnung
 * hinter dem Reaktions-Umschlag (Uebergabe P1.5, „Reaktion als Postfach-
 * Umschlag").
 *
 * Eine verschluesselte Nachricht hat keine Server-Zeile, also auch keine
 * `message_reactions`-Zeile und kein `reaction_add`-Ereignis. Eine Reaktion
 * reist stattdessen als eigener Umschlag ueber das blinde Postfach
 * (`nachrichtNutzlast.ts::baueReaktionsNutzlast`) — an die Gegenstelle UND
 * an die eigenen anderen Geraete, wie jede Nachricht. Jedes Geraet fuehrt
 * am Verlaufs-Satz der Zielnachricht die Liste der (Autor, Emoji)-Paare
 * (`verlauf/schema.ts::Satz.reaktionen`) und rechnet daraus die Anzeige-Form
 * `{emoji, count, me}`, die `MessageReactions.svelte` schon kennt.
 *
 * Warum Paare statt der fertigen Aggregate: der Umschlag kann doppelt
 * ankommen (verlorene Quittung, s. `empfangen.ts`-Modulkopf) — ein Zaehler
 * wuerde dann falsch hochlaufen. Paare sind idempotent: derselbe Autor mit
 * demselben Emoji ist EIN Eintrag, egal wie oft der Umschlag kommt. Und nur
 * der Autor selbst entfernt seine Reaktion — ein Umschlag von B kann keine
 * Reaktion von A ausradieren.
 *
 * Importfrei, damit Nodes eingebauter Testlaeufer die Datei ohne Bundler
 * prueft (s. CLAUDE.md „Die Falle").
 */

/** Ein Eintrag am Verlaufs-Satz: WER hat mit WAS reagiert. */
export type ReaktionsZeile = { emoji: string; userId: string };

/** Die Anzeige-Form — strukturell `api/types.ts::ReactionAggregate`. */
export type ReaktionsAggregat = { emoji: string; count: number; me: boolean };

/**
 * Wendet EINEN Reaktions-Umschlag auf den Bestand an. Gibt bei „nichts
 * geaendert" (doppelter Umschlag, Entfernen ohne eigenen Eintrag) DIESELBE
 * Referenz zurueck — der Aufrufer erkennt daran, dass kein Schreibvorgang
 * noetig ist.
 */
export function reaktionAnwenden(
  zeilen: ReaktionsZeile[] | undefined,
  autorId: string,
  emoji: string,
  entfernen: boolean
): ReaktionsZeile[] | undefined {
  const bestand = zeilen ?? [];
  const trifft = (z: ReaktionsZeile) => z.userId === autorId && z.emoji === emoji;
  if (entfernen) {
    const rest = bestand.filter((z) => !trifft(z));
    return rest.length === bestand.length ? zeilen : rest;
  }
  if (bestand.some(trifft)) return zeilen;
  return [...bestand, { emoji, userId: autorId }];
}

/** Paare -> Anzeige-Form, in Reihenfolge des ersten Auftretens je Emoji. */
export function reaktionenZuAggregat(
  zeilen: ReaktionsZeile[] | undefined,
  eigenesKontoId: string | null
): ReaktionsAggregat[] {
  if (!zeilen || zeilen.length === 0) return [];
  const nachEmoji = new Map<string, ReaktionsAggregat>();
  for (const z of zeilen) {
    const eintrag = nachEmoji.get(z.emoji) ?? { emoji: z.emoji, count: 0, me: false };
    eintrag.count += 1;
    if (z.userId === eigenesKontoId) eintrag.me = true;
    nachEmoji.set(z.emoji, eintrag);
  }
  return [...nachEmoji.values()];
}
