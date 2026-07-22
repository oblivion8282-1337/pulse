/**
 * Fernsteuerung — zentrale ICE-Server-Konfiguration (M3).
 *
 * EINE Quelle für Controller (`controller.svelte.ts`) und Host
 * (`hostBridge.ts`), damit TURN an genau einer Stelle reinkommt statt an zwei
 * hartcodierten.
 *
 * **Stand:** nur STUN. Für gleiches-Netz-Tests reicht das (Host-/Server-
 * reflexive-Kandidaten). **TURN ist Pflicht** für netzübergreifende
 * Consumer↔Consumer-Verbindungen (s. Handoff/Latenz-Messung) — die Creds sollen
 * später zeitlich begrenzt vom Server kommen (coturn HMAC, analog WHEP-Token),
 * dann per `setIceServers()` gesetzt werden (z.B. aus dem ready-Frame oder einem
 * eigenen Endpoint), bevor eine Session startet.
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
