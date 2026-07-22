/**
 * Fernsteuerung — zentrale ICE-Server-Konfiguration (M3).
 *
 * EINE Quelle für Controller (`controller.svelte.ts`) und Host
 * (`hostBridge.ts`), damit TURN an genau einer Stelle reinkommt statt an zwei
 * hartcodierten.
 *
 * **Default:** nur STUN — reicht im gleichen Netz (Host-/Server-reflexive
 * Kandidaten). **TURN ist Pflicht** für netzübergreifende
 * Consumer↔Consumer-Verbindungen (s. Handoff/Latenz-Messung); die kurzlebigen
 * Creds (coturn HMAC, analog WHEP-Token) holt `refreshIceServers()` vom Server
 * und setzt sie per `setIceServers()`, kurz bevor eine Session startet.
 */

const STUN_ONLY: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

let iceServers: RTCIceServer[] = STUN_ONLY;

/** Aktuelle ICE-Server (STUN-Default, bis TURN gesetzt wird). */
export function getIceServers(): RTCIceServer[] {
  return iceServers;
}

/** ICE-Server überschreiben (z.B. STUN + TURN vom Server). Leere Liste → Default. */
export function setIceServers(servers: RTCIceServer[]): void {
  iceServers = servers.length > 0 ? servers : STUN_ONLY;
}

/**
 * ICE-Server frisch vom Server holen (STUN + ggf. TURN mit kurzlebigen Creds)
 * und setzen. Kurz VOR jeder Session aufrufen — die TURN-Credentials laufen ab.
 * Fehlschlag ist folgenlos: der STUN-Default bleibt, die Session startet trotzdem
 * (im gleichen LAN reicht das). Lazy-Import bricht den Zyklus zum WS-/API-Layer.
 */
export async function refreshIceServers(): Promise<void> {
  try {
    const { chatApi } = await import('$lib/api/chat');
    const res = await chatApi.getRemoteIceServers();
    setIceServers(res.ice_servers);
  } catch {
    // Nicht erreichbar / kein TURN → auf den STUN-Default zurücksetzen, statt
    // (evtl. abgelaufene) Creds vom letzten Refresh weiterzuschleppen.
    setIceServers(STUN_ONLY);
  }
}
