/**
 * Fernsteuerung — der Draht unter der Sitzung.
 *
 * Nur Verbindungs-Klempnerei, kein Zustand: welche Verbindung ein Frame
 * gebracht hat, wie man auf einer festgehaltenen sendet, und wie man eine
 * Sitzung loswird, die einen nichts angeht. Liegt neben `wachten.ts` aus
 * demselben Grund — der Session-Store soll die Zustandsmaschine zeigen und
 * nicht die Leitungen.
 */

import { gatewayForServer } from '$lib/ws/connection';
import type { GatewayConnection } from '$lib/ws/connection';
import { dispatchingServerId } from '$lib/ws/gateway-connection';

/**
 * Die Verbindung, über die der gerade verarbeitete Frame hereinkam.
 *
 * Der Dispatch ist synchron (s. `dispatchingServerId`), während der Bearbeitung
 * eines Frames steht seine Herkunft also noch fest. Eine Antwort gehört immer
 * dorthin zurück: nach einem Community-Wechsel zeigt der `gateway`-Proxy auf
 * einen Server, der die Sitzung gar nicht kennt.
 */
export function herkunftsVerbindung(): GatewayConnection | null {
  const von = dispatchingServerId();
  return von ? gatewayForServer(von) : null;
}

/**
 * Senden über eine festgehaltene Verbindung. `false` = nicht hinausgegangen.
 *
 * Fängt auch einen Wurf ab: die Aufrufer stehen in Pfaden, die danach noch
 * aufräumen (`deny`, `end`, `cancel`) — eine durchgereichte Ausnahme übersprünge
 * genau das und fröre die Oberfläche im Sitzungszustand ein.
 */
export function sendenAuf(
  conn: GatewayConnection | null,
  fn: (c: GatewayConnection) => boolean,
): boolean {
  if (!conn) return false;
  try {
    return fn(conn);
  } catch {
    return false;
  }
}

/**
 * Eine Sitzung, die uns gemeldet wird, aber nicht die unsere ist, sofort
 * serverseitig beenden — auf der Verbindung, über die sie hereinkam.
 *
 * Ignorieren reicht nicht: eine Sitzung, die auf unseren Namen wartet, hält
 * beim Host bis zu 30 s einen Zustimmungsdialog offen, und ein später Klick auf
 * „Erlauben" sperrt ihn danach stundenlang für weitere Anfragen. `remote_end`
 * auf eine unbekannte Sitzung ist beim Gateway folgenlos (idempotent, keine
 * Fehlermeldung) — es kostet also nichts, im Zweifel abzuräumen.
 */
export function fremdeSitzungBeenden(sessionId: string): void {
  if (!sessionId) return;
  // Wurf = Verbindung schon abgeräumt; dann hat der Gateway die Sitzung mit ihr
  // beendet (`cleanup_remote_on_disconnect`).
  sendenAuf(herkunftsVerbindung(), (c) => c.sendRemoteEnd(sessionId));
}
