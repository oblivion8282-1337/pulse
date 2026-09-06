import { vergleicheSnowflakeArtigeId } from '../utils/snowflakeZeit.ts';

/**
 * Fuehrt lokale und Server-Treffer der DM-Suche zu EINER Liste zusammen —
 * importfrei (s. `sucheTreffer.ts`-Modulkopf, dasselbe Muster).
 *
 * **Woran ein Doppel erkennbar ist:** `dm_channel_id` + `message_id`. Das ist
 * dieselbe Kennung, die den lokalen Primaerschluessel bildet
 * (`satz.ts::sortierSchluessel`) — ein und dieselbe physische Nachricht kann
 * in BEIDEN Quellen auftauchen, weil der lokale Verlauf seit C1 JEDE
 * DM-Nachricht ablegt, die dieses Geraet live gesehen hat (`ws/handlers/
 * chat.ts`, `ws/gapFill.ts`), nicht nur verschluesselte. Eine unverschluesselte
 * Nachricht, die der Server kennt UND die dieses Geraet seit C1 online war,
 * liegt also doppelt vor. `content`/`author_id`/`created_at` sind fuer so ein
 * Duplikat identisch (dieselbe Nachricht) — welche Kopie gewinnt, ist deshalb
 * keine Korrektheits-, sondern nur eine Praeferenzfrage. Die lokale gewinnt:
 * sie ist bereits vorhanden (kein zusaetzlicher Roundtrip fuer den „Treffer
 * oeffnen"-Klick spaeter noetig) und macht das Ergebnis unabhaengiger von
 * einem gerade langsamen/fehlgeschlagenen Server-Aufruf.
 *
 * Sortierung wie bei `sucheTreffer.ts`: ueber die eingebettete Zeit der
 * Nachrichten-ID (`vergleicheSnowflakeArtigeId`), nicht ueber `created_at` —
 * lokale und Server-Treffer koennen aus verschiedenen ID-Schemata stammen.
 */

export type Treffer = {
  message_id: string;
  dm_channel_id: string;
  author_id: string;
  content: string;
  created_at: string;
};

function schluessel(t: Treffer): string {
  return `${t.dm_channel_id}:${t.message_id}`;
}

/** `limit` entspricht der Obergrenze EINER Quelle (`LOKALE_SUCHE_LIMIT`/
 *  `_SUCHE_LIMIT`) — nach dem Zusammenfuehren kann die Summe beider Quellen
 *  darueber liegen, eine Suchleiste will aber weiterhin Treffer statt
 *  Chronologie. */
export function sucheZusammenfuehren<T extends Treffer>(
  lokal: T[],
  vomServer: T[],
  limit: number
): T[] {
  const bekannt = new Set(lokal.map(schluessel));
  const ohneDoppel = vomServer.filter((t) => !bekannt.has(schluessel(t)));
  return [...lokal, ...ohneDoppel]
    .sort((a, b) => vergleicheSnowflakeArtigeId(b.message_id, a.message_id))
    .slice(0, limit);
}
