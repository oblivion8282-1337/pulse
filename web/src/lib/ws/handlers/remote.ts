/**
 * WS-Handler für die Fernsteuerung (remote control). Leitet die Inbound-Ops
 * des Consent-Handshakes in den Session-Store (`$lib/remote/session.svelte`)
 * und die Eingabe-Frames in den Sidecar (`$lib/remote/sidecarInput`).
 *
 * Die `op:'error'`-Codes (4050–4054) fängt der Store selbst per `gateway.on()`
 * ab, solange er auf eine Freigabe wartet — deshalb hier kein error-Handler.
 *
 * Kein `remote_signal`-Handler: das trägt SDP/ICE für den WebRTC-P2P-Pfad
 * (liegt auf `feat/remote-control-windows`) — diese Oberfläche fährt nur den
 * Consent-Handshake über den Serverweg, ohne Verhandlungsphase.
 */
import { registerWsHandler } from '../handler-registry';
import { remoteSession } from '$lib/remote/session.svelte';
import { eingabeEinspielen } from '$lib/remote/sidecarInput';

/**
 * Eingabe-Frames einspielen — aber nur, wenn für genau diese Sitzung wirklich
 * eine läuft, in der ICH der Host bin.
 *
 * Der Gateway prüft das ebenfalls, und trotzdem steht es hier noch einmal: die
 * Prüfung kostet nichts, und ihr Gegenstand ist der Zugriff auf Maus und
 * Tastatur dieses Rechners. Alles, was nicht zur bestätigten Sitzung gehört,
 * wird stillschweigend verworfen.
 */
async function eingabe(evt: {
  session_id: string;
  slot: number;
  frames: string[];
}): Promise<void> {
  if (remoteSession.phase !== 'active' || remoteSession.role !== 'host') return;
  if (!evt.session_id || evt.session_id !== remoteSession.sessionId) return;
  if (!Array.isArray(evt.frames) || evt.frames.length === 0) return;
  if (await eingabeEinspielen(evt.slot, evt.session_id, evt.frames)) return;
  // Fail-closed: der Sidecar hat die Eingabe-Sitzung stillgelegt (oder es gibt
  // gar keine Brücke). Ab hier käme nichts mehr an, auch kein Hoch-Ereignis —
  // eine Sitzung, die nur noch Tasten drückt, ist schlimmer als keine.
  // Erneut prüfen: zwischen Absenden und Antwort kann sie schon geendet haben,
  // und dann gehörte dieses `end()` einer fremden Sitzung.
  if (remoteSession.sessionId === evt.session_id) remoteSession.end();
}

export function register(): void {
  registerWsHandler('remote_request', (evt) =>
    remoteSession._incomingRequest(evt.session_id, evt.channel_id, evt.from_user_id),
  );
  registerWsHandler('remote_response', (evt) =>
    remoteSession._response(evt.session_id, evt.accepted),
  );
  registerWsHandler('remote_ended', (evt) =>
    remoteSession._ended(evt.session_id, evt.reason),
  );
  registerWsHandler('remote_canceled', (evt) => remoteSession._dismissIncoming(evt.session_id));
  registerWsHandler('remote_input', (evt) => eingabe(evt));
}
