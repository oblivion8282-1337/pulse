/**
 * Der Zustellstand, den ein Empfänger mit seiner Quittung meldet (doppelt
 * grauer Haken, Migration 0101): je (Kanal, Absender) die kanonische ID der
 * jüngsten Nachricht, die in diesem Zyklus sicher abgelegt wurde.
 *
 * Nur der Empfänger kann ihn bilden — die kanonische ID steckt im Umschlag,
 * der Server sieht sie nie. Je ABSENDER, weil die ID aus dessen Uhr stammt:
 * nur gegen seine eigenen IDs vergleicht er ohne Zeitversatz.
 *
 * Importfrei, damit Nodes Testläufer die Rechnung prüft.
 */
import { compareSnowflakeId } from '../utils/snowflake.ts';
import { lesestandAnker } from '../stores/lesestandKern.ts';

export interface ZustellstandMeldung {
  channel_id: string;
  absender_user_id: string;
  zugestellt_bis: string;
}

interface Abgelegt {
  id: string;
  channel_id: string;
  author_id: string;
  krypto_id?: string;
}

/** `quittiert` = die Zustellungs-IDs, die gleich quittiert werden — eine
 *  Nachricht, deren Ablage scheiterte, bleibt liegen und zählt noch nicht.
 *  Eigene Nachrichten (vom Zweitgerät) sind kein Fall für den Haken. */
export function zustellstaendeAus(
  nachrichten: readonly Abgelegt[],
  quittiert: ReadonlySet<string>,
  ich: string | null
): ZustellstandMeldung[] {
  const jePaar = new Map<string, ZustellstandMeldung>();
  for (const n of nachrichten) {
    if (!quittiert.has(n.id) || n.author_id === ich) continue;
    const anker = lesestandAnker(n);
    const schluessel = `${n.channel_id}:${n.author_id}`;
    const bisher = jePaar.get(schluessel);
    if (!bisher || compareSnowflakeId(anker, bisher.zugestellt_bis) > 0) {
      jePaar.set(schluessel, {
        channel_id: n.channel_id,
        absender_user_id: n.author_id,
        zugestellt_bis: anker
      });
    }
  }
  return [...jePaar.values()];
}
