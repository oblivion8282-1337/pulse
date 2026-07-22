/**
 * WS-Handler für die Fernsteuerung (remote control, M3). Leitet die vier
 * Inbound-Ops in den Session-Store (`$lib/remote/session.svelte`). Die
 * `op:'error'`-Codes (4050–4054) fängt der Store selbst per `gateway.on()`
 * ab, solange er auf eine Freigabe wartet — deshalb hier kein error-Handler.
 */
import { registerWsHandler } from '../handler-registry';
import { remoteSession } from '$lib/remote/session.svelte';

export function register(): void {
  registerWsHandler('remote_request', (evt) =>
    remoteSession._incomingRequest(evt.session_id, evt.channel_id, evt.from_user_id),
  );
  registerWsHandler('remote_response', (evt) =>
    remoteSession._response(evt.session_id, evt.accepted),
  );
  registerWsHandler('remote_signal', (evt) =>
    remoteSession._signal(evt.session_id, evt.kind, evt.data),
  );
  registerWsHandler('remote_ended', (evt) =>
    remoteSession._ended(evt.session_id, evt.reason),
  );
}
