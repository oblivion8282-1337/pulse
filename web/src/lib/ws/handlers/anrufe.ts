/** WS-Signalisierung für Anrufe (Anrufe-Epic B) — Ephemeral-Events, die
 *  den Zustand im `anrufe`-Store treiben. Medien laufen über LiveKit. */

import type { HandlerContext } from './context';
import { registerWsHandler } from '../handler-registry';
import { anrufe } from '$lib/anrufe/anruf.svelte';
import { sendeAnrufSystemzeile } from '$lib/anrufe/systemzeileSenden';
import { userCache } from '$lib/stores/users.svelte';

export function register(_ctx: HandlerContext): void {
  // Die Systemzeile wird hier angedockt — einmalig beim Gateway-Aufbau, bevor
  // es Anrufe geben kann, und unabhängig von der gerade offenen Seite.
  anrufe.zeilenZielSetzen(sendeAnrufSystemzeile);

  registerWsHandler('call_klingelt', (evt) => {
    anrufe.eingehend(evt, userCache.displayName(evt.einleiter_id));
  });

  registerWsHandler('call_angenommen', (evt) => {
    anrufe.verbindenNachAnnahme(evt.call_id);
  });

  registerWsHandler('call_abgelehnt', () => {
    anrufe.gegenstelleAbgelehnt();
  });

  registerWsHandler('call_ende', (evt) => {
    anrufe.ende(evt.call_id, evt.grund, evt.dauer_sek);
  });
}
