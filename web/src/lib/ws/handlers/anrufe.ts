/** WS-Signalisierung für Anrufe (Anrufe-Epic B) — Ephemeral-Events, die
 *  den Zustand im `anrufe`-Store treiben. Medien laufen über LiveKit. */

import type { HandlerContext } from './context';
import { registerWsHandler } from '../handler-registry';
import { sendeAnrufSystemzeile } from '$lib/anrufe/systemzeileSenden';
import { userCache } from '$lib/stores/users.svelte';
import { auth } from '$lib/stores/auth.svelte';

/** Der Anruf-Store — als gecachten dynamischen Import: `anruf.svelte` zieht
 *  das ganze livekit-client-SDK (472 KB) nach sich und darf deshalb nicht im
 *  statischen First-Load des Root-Layouts hängen (dorthin reicht die Kette
 *  Gateway → Handler-Bootstrap → diese Datei). `register()` wärmt den Chunk
 *  beim Gateway-Aufbau vor, bevor es Anrufe geben kann; danach ist jedes
 *  `await` ein bereits aufgelöster Mikro-Task — die Ereignis-Reihenfolge
 *  bleibt gewahrt (FIFO über dieselbe Promise). */
let anrufModul: Promise<typeof import('$lib/anrufe/anruf.svelte')> | null = null;
function anrufModulLaden(): Promise<typeof import('$lib/anrufe/anruf.svelte')> {
  return (anrufModul ??= import('$lib/anrufe/anruf.svelte'));
}

export function register(_ctx: HandlerContext): void {
  // Die Systemzeile wird hier angedockt — einmalig beim Gateway-Aufbau, bevor
  // es Anrufe geben kann, und unabhängig von der gerade offenen Seite. Über
  // dieselbe Promise wie die Handler läuft das Andocken garantiert vor dem
  // ersten Event (FIFO).
  void anrufModulLaden().then(({ anrufe }) => anrufe.zeilenZielSetzen(sendeAnrufSystemzeile));

  registerWsHandler('call_klingelt', async (evt) => {
    // Name-Auflösung noch synchron im Dispatch-Fenster.
    const gegenstelle = userCache.displayName(evt.einleiter_id);
    const { anrufe } = await anrufModulLaden();
    anrufe.eingehend(evt, gegenstelle);
  });

  registerWsHandler('call_angenommen', async (evt) => {
    // Die eigene Kennung: das eigene Zweitgerät hat abgenommen — hier klingelt
    // es noch, und der 45-s-Wecker müsste entschärft werden (früher feuerte
    // er „ablehnen“ und riss den laufenden Anruf tot, Befund 03.10.).
    // Vergleich noch synchron im Dispatch-Fenster (wie beim Klingeln).
    const eigenesKonto = evt.user_id === String(auth.user?.id ?? '');
    const { anrufe } = await anrufModulLaden();
    if (eigenesKonto) {
      anrufe.zweitgeraetAngenommen(evt.call_id);
      return;
    }
    anrufe.verbindenNachAnnahme(evt.call_id);
  });

  registerWsHandler('call_abgelehnt', async () => {
    const { anrufe } = await anrufModulLaden();
    anrufe.gegenstelleAbgelehnt();
  });

  registerWsHandler('call_ende', async (evt) => {
    const { anrufe } = await anrufModulLaden();
    anrufe.ende(evt.call_id, evt.grund, evt.dauer_sek);
  });
}
