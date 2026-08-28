/**
 * Hochscroll-Nachladen (`MessageList::loadOlder`) — ausgelagert, damit die
 * Komponente unter der Größen-Policy bleibt. Reine Verdrahtung (lokal ↔
 * Server), keine eigene Rechnung — deshalb hier, nicht importfrei.
 *
 * C2: erst lokal, und nur wenn dort nichts mehr liegt, den Server fragen.
 * Für Guild-Kanäle liefert `verlaufLesen` immer `[]` (nur DMs landen lokal,
 * s. `verlauf/index.ts::istDmKanal`) — dort greift also unverändert der
 * Server-Zweig, wie vor C2.
 *
 * "Lokal hat etwas geliefert" ist dabei NICHT gleichbedeutend mit "das ist
 * die richtige naechste Seite" (Bughunt Fund 2): ein Gap-Fill-Overflow
 * (`ws/gapFill.ts`) legt nur die neueste Serverseite lokal ab, der alte
 * Bestand VOR der Luecke bleibt unangetastet liegen — ein Cursor, der genau
 * in diese Luecke faellt, findet also lokal Zeilen, nur eben die FALSCHEN
 * (den alten Bestand, faelschlich als naechste zusammenhaengende Seite
 * gedeutet). `betrifftLuecke` faengt genau diesen Fall ab, s. `luecke.ts`.
 */
import { verlaufLesen, verlaufSpeichern } from './index';
import { betrifftLuecke, lueckeNachServerantwortAktualisieren } from './luecke';
import { chatApi } from '$lib/api/chat';
import type { Message } from '$lib/api/types';

export type AeltereSeite = {
  nachrichten: Message[];
  /** `true`, wenn die Seite vom Server kam — nur dann sagt "kürzer als
   *  angefragt" wirklich "Historie-Ende", und nur dann lohnt das erneute
   *  Ablegen im lokalen Verlauf (lokal gelesene Sätze liegen dort schon). */
  vomServer: boolean;
};

export async function ladeAeltereSeite(
  channelId: string,
  oldest: string,
  seitenGroesse: number,
  route: { serverId?: string } | undefined
): Promise<AeltereSeite> {
  if (!betrifftLuecke(channelId, oldest)) {
    const lokal = (await verlaufLesen(channelId, { vor: oldest, anzahl: seitenGroesse })).filter(
      (n) => n.deleted_at === null
    );
    if (lokal.length > 0) return { nachrichten: lokal, vomServer: false };
  }

  const vomServer = await chatApi.listMessages(
    channelId,
    { before: oldest, limit: seitenGroesse },
    route
  );
  void verlaufSpeichern(channelId, vomServer);
  // `listMessages` liefert neueste zuerst (s. `ws/gapFill.ts`), der letzte
  // Eintrag ist also die aelteste Nachricht dieser Seite.
  lueckeNachServerantwortAktualisieren(
    channelId,
    vomServer[vomServer.length - 1]?.id,
    vomServer.length < seitenGroesse
  );
  return { nachrichten: vomServer, vomServer: true };
}
