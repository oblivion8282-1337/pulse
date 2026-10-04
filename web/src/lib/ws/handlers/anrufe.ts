/** WS-Signalisierung für Anrufe (Anrufe-Epic B) — Ephemeral-Events, die
 *  den Zustand im `anrufe`-Store treiben. Medien laufen über LiveKit. */

import type { HandlerContext } from './context';
import { registerWsHandler } from '../handler-registry';
import { anrufe } from '$lib/anrufe/anruf.svelte';
import { sendeAnrufSystemzeile } from '$lib/anrufe/systemzeileSenden';
import { userCache } from '$lib/stores/users.svelte';
import { auth } from '$lib/stores/auth.svelte';

export function register(_ctx: HandlerContext): void {
  // Die Systemzeile wird hier angedockt — einmalig beim Gateway-Aufbau, bevor
  // es Anrufe geben kann, und unabhängig von der gerade offenen Seite.
  anrufe.zeilenZielSetzen(sendeAnrufSystemzeile);

  registerWsHandler('call_klingelt', (evt) => {
    anrufe.eingehend(evt, userCache.displayName(evt.einleiter_id));
  });

  registerWsHandler('call_angenommen', (evt) => {
    // Die eigene Kennung: das eigene Zweitgerät hat abgenommen — hier klingelt
    // es noch, und der 45-s-Wecker müsste entschärft werden (früher feuerte
    // er „ablehnen“ und riss den laufenden Anruf tot, Befund 03.10.).
    if (evt.user_id === String(auth.user?.id ?? '')) {
      anrufe.zweitgeraetAngenommen(evt.call_id);
      return;
    }
    anrufe.verbindenNachAnnahme(evt.call_id);
  });

  registerWsHandler('call_abgelehnt', () => {
    anrufe.gegenstelleAbgelehnt();
  });

  registerWsHandler('call_ende', (evt) => {
    anrufe.ende(evt.call_id, evt.grund, evt.dauer_sek);
  });
}
