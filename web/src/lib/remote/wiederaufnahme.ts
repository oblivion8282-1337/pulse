/**
 * Fernsteuerung — was nach einem geglückten Reclaim zu behaupten ist.
 *
 * Eigene Datei, statt in `session.svelte.ts` (Prüferbefund 2026-08-20): die
 * Datei lag mit 536 Zeilen schon vor dieser Ergänzung über der harten
 * Größen-Grenze (PLAN.md §12.1, 500 Zeilen) — noch eine Methode dort hinein
 * wäre die dritte in Folge gewesen, ohne dass sie jemand herauslöst.
 * Backend-seitig ist genau das schon passiert (`remote_reconnect_registry.py`
 * aus `remote_registry.py`, aus demselben Grund); hier zieht die Client-Seite
 * nach.
 */
import { remoteP2P } from './p2p';
import type { RemoteRole } from './session.svelte';

/**
 * Hello + alles noch Gehaltene erneut behaupten — derselbe Weg wie beim
 * Rückfall Kanal→Serverweg in `session.svelte.ts::sendInput`.
 *
 * Bughunt 2026-08-19/20, zweite Runde (Befund 5/6): ohne das blieb eine vom
 * Steuernden gehaltene Taste nach einem Verbindungsabriss + erfolgreichem
 * Reclaim am fernen Rechner hängen — vor der Gnadenfrist erledigte das
 * `#reset()` → `eingabeFreigeben()` beim Sofort-Ende, und die Frist hat
 * diesen Aufräumer ersetzt, ohne einen Ersatz mitzubringen.
 *
 * Folgenlos ausserhalb der Rolle 'controller' — ein Reclaim des Hosts hat
 * hier nichts zu behaupten (der Host sendet keine Eingabe).
 *
 * `senden` ist der server-seitige `remote_input`-Weg der aufrufenden Sitzung
 * (`session.svelte.ts::#senden` mit `sendRemoteInput`) — bewusst NICHT der
 * öffentliche `sendInput()`, der selbst hierher zurückverzweigen könnte.
 */
export function nachReclaimBehaupten(
  rolle: RemoteRole | null,
  senden: (frames: string[]) => boolean,
): void {
  if (rolle !== 'controller') return;
  if (senden(remoteP2P.helloBuendel())) {
    remoteP2P.wsHelloGesendet();
    for (const buendel of remoteP2P.nachziehBuendel()) {
      senden(buendel);
    }
  }
}
