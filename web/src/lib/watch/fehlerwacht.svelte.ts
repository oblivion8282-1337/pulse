/**
 * Watch-Party — die Ablehnungen des Servers sichtbar machen.
 *
 * Der generische `error`-Verteiler (`ws/handlers/error.ts`) ist bewusst ein
 * Nichtstuer: jede Domäne meldet sich für ihren eigenen Code-Bereich selbst an
 * (Vorbild `remote/wachten.ts` für 4050–4059). Für die Watch-Party fehlte das
 * ganz — der Dialog schliesst schon, sobald der Sendeversuch lokal rausging,
 * der Server prüft danach noch einmal und kann ablehnen. Diese Ablehnung kam
 * bis zum Bughunt vom 17. August NIRGENDS an, weder beim Starten noch beim
 * Wechseln des Videos.
 *
 * **Warum im Layout und nicht in den Komponenten** (Nachlese zum Fix): der
 * Startknopf hängt an jedem Sprachkanal, die Kachel an jeder laufenden Party.
 * Beide sind gleichzeitig eingehängt, sobald eine Party läuft — zwei Wachten
 * ergäben zwei Meldungen für eine Ablehnung. Umgekehrt gibt es die Kachel ohne
 * den Knopf (Popup-Fenster, Mobil), dort fehlte die Wacht sonst ganz. Die
 * beiden Layouts, die sie rufen, schliessen einander aus: das Popup ist ein
 * eigenes Fenster und damit ein eigenes Modul.
 */

import { toast } from 'svelte-sonner';

import * as m from '$lib/paraglide/messages';
import { useGatewayListener } from '$lib/ws/useGatewayListener.svelte';

// Codes aus ws_watch.py, ausschliesslich vom Watch-Party-Pfad benutzt
// (Code-Audit in ws_op_gate.py). Der Server schickt sie nur an den Socket, der
// die abgelehnte Aktion ausgelöst hat — kein Broadcast, also keine
// Verwechslungsgefahr mit fremden Anfragen.
const WATCH_CODE_UNSUPPORTED_SOURCE = 4013;
const WATCH_CODE_TOO_MANY_PARTIES = 4014;

/**
 * Meldet die Watch-Party-Fehlerwacht an. Gehört ins Top-Level des
 * `<script>`-Blocks eines Layouts — `useGatewayListener` benutzt `$effect` und
 * braucht den Komponenten-Kontext.
 */
export function watchFehlerWacht(): void {
  useGatewayListener((evt) => {
    if (evt.op !== 'error') return;
    if (evt.code === WATCH_CODE_UNSUPPORTED_SOURCE) {
      toast.error(m.watch_party_start_button_url_unsupported());
    } else if (evt.code === WATCH_CODE_TOO_MANY_PARTIES) {
      toast.error(m.watch_party_start_button_already_running());
    }
  });
}
