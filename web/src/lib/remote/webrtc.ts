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
    // Nur die Impl der aktuellen Rolle stoppen (kein spurioses `remoteStop` an
    // einen Sidecar, der gar keine Host-Session fährt). Ist die Rolle (noch)
    // unbekannt — Teardown, bevor sie feststand —, vorsichtshalber beide.
    const role = remoteSession.role;
    if (role === null || role === 'controller') remoteController.stop();
    if (role === null || role === 'host') remoteHostBridge.stop();
  },
};

remoteSession.attachWebrtc(dispatcher);
