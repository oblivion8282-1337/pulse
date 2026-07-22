/**
 * Fernsteuerung — WebRTC-Dispatcher (M3, Scheibe 6).
 *
 * Der Store kennt nur EINE `RemoteWebrtc`-Naht, es gibt aber zwei
 * Implementierungen je nach Rolle: der **Controller** fährt Browser-WebRTC
 * (Scheibe 3), der **Host** reicht ans Sidecar durch (Scheibe 6). Dieser
 * Dispatcher routet die Aufrufe nach Rolle und hängt sich EINMALIG in den Store.
 *
 * Als Seiteneffekt beim Import verdrahtet — das `app/+layout` importiert dieses
 * Modul, damit die Fernsteuerung ab App-Start scharf ist.
 */

import { remoteSession, type RemoteRole, type RemoteWebrtc } from './session.svelte';
import type { RemoteSignalKind } from '$lib/ws/gateway-senders';
import { remoteController } from './controller.svelte';
import { remoteHostBridge } from './hostBridge';

// Welche Impl die Rolle fährt: Host → Sidecar-Brücke, sonst Controller-Browser.
function implFor(role: RemoteRole | null): RemoteWebrtc {
  return role === 'host' ? remoteHostBridge : remoteController;
}

const dispatcher: RemoteWebrtc = {
  start(sessionId: string, role: RemoteRole): void {
    implFor(role).start(sessionId, role);
  },
  handleSignal(kind: RemoteSignalKind, data: string): void {
    implFor(remoteSession.role).handleSignal(kind, data);
  },
  stop(): void {
    // Beide stoppen ist idempotent — sicher, egal welche Rolle lief, und deckt
    // auch einen Teardown ab, bevor die Rolle überhaupt feststand.
    remoteController.stop();
    remoteHostBridge.stop();
  },
};

remoteSession.attachWebrtc(dispatcher);
