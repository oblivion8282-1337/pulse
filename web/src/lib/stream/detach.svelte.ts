/**
 * Detach-Streams: ein HQ-Stream-Player kann in ein zweites Fenster/Tab
 * abgekoppelt werden. Der Player im Hauptfenster wird dann durch einen
 * Placeholder ersetzt — wichtig, damit die WHEP-Verbindung dort wirklich
 * abgebaut wird (kein doppeltes Subscriben + doppelte Bandbreite).
 *
 * Pro *(channel, user, slot)* — ein User kann mehrere Streams (Slots) fahren,
 * und jeder lässt sich einzeln in ein eigenes Fenster abkoppeln.
 *
 * Sync zwischen Haupt- und Popup-Fenster läuft über `BroadcastChannel`:
 *   * main  → popup: `{ kind: 'close', cid, uid, slot }`   (stream geht offline)
 *   * popup → main:  `{ kind: 'closed', cid, uid, slot }`  (popup wurde geschlossen)
 *
 * Wir verfolgen geöffnete Popup-Fensterreferenzen lokal (nur im
 * eigenen Tab gültig) damit „Fenster fokussieren" / „Schließen" funktioniert.
 * Der Mechanismus (Channel, Sweep-Poll, Zentrierung) lebt in der gemeinsamen
 * `PopupDetacher`-Basis — hier steht nur die Konfiguration.
 */
import { PopupDetacher } from './popupDetacher.svelte';

export const detachedStreams = new PopupDetacher<[string, string, number]>({
  channelName: 'pulse:stream-detach',
  key: (cid, uid, slot) => [cid, uid, slot].join('::'),
  msg: (kind, cid, uid, slot) => ({ kind, cid, uid, slot }),
  parse: (m) => [m.cid as string, m.uid as string, m.slot as number],
  popupUrl: (cid, uid, slot) =>
    `/stream-popup/${encodeURIComponent(cid)}/${encodeURIComponent(uid)}?slot=${slot}`,
  windowName: (k) => `pulse-stream-${k}`
});
