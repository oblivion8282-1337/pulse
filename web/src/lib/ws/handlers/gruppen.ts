/** `gruppe_neu` — eine private Gruppe ist neu oder hat Mitglieder gewonnen.
 *
 *  Etappe G2 kannte kein Mitgliederwechsel-Ereignis: nur Gruppen, die beim
 *  `ready` schon bekannt waren, wurden abonniert (`handlers/ready.ts`). Wer
 *  später hinzukam, erfuhr von der Gruppe erst beim nächsten Neuladen — bis
 *  dahin kein Abo, kein `postfach_neu`, keine Benachrichtigung und keine
 *  Live-Nachricht (Befund 05.10.).
 *
 *  Der Handler zieht `GET /gruppen` nach, übernimmt den Bestand und
 *  abonniert die KANÄLE aller neuen Gruppen (die UI-Liste aktualisiert sich
 *  über den Store von allein). Bewusst auch im Hintergrund-Tab — dort ist
 *  die Benachrichtigung der ganze Punkt.
 */

import type { HandlerContext } from './context';
import { registerWsHandler } from '../handler-registry';
import { gruppenApi } from '$lib/api/gruppen';
import { privateGruppen } from '$lib/stores/privateGruppen.svelte';
import { cloudGateway } from '$lib/ws/connection';
import { readState } from '$lib/stores/readState.svelte';
import { quittungen } from '$lib/stores/quittungen.svelte';
import { dispatchingUserId } from '$lib/stores/currentServerUser';

export function register(_ctx: HandlerContext): void {
  registerWsHandler('gruppe_neu', () => {
    void gruppenApi
      .auflisten()
      .then((gruppen) => {
        const bekannt = new Set(privateGruppen.list.map((g) => g.id));
        privateGruppen.seed(gruppen);
        for (const gruppe of gruppen) {
          if (!bekannt.has(gruppe.id)) cloudGateway.subscribe(gruppe.id);
        }
      })
      .catch(() => {
        // Der ready-Lauf holt denselben Stand ohnehin — still.
      });
  });

  registerWsHandler('gruppe_lesestand', (evt) => {
    quittungen.gelesenMelden(evt.gruppe_id, evt.user_id, evt.last_read_message_id);
    // Der eigene Stand kommt auch zurück — die anderen Geräte löschen damit
    // ihre Zähler (dasselbe wie `dm_lesestand` in `chat.ts`).
    if (evt.user_id === dispatchingUserId()) {
      readState.seedOwnLesestand(evt.gruppe_id, evt.last_read_message_id);
    }
  });

  registerWsHandler('zustellung_bestaetigt', (evt) => {
    quittungen.zugestelltMelden(evt.channel_id, evt.user_id, evt.zugestellt_bis);
  });
}
