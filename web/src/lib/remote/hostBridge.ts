/**
 * Fernsteuerung — Host-Brücke (M3, Scheibe 6).
 *
 * Die **Host-Seite** fährt KEIN Browser-WebRTC: der Sidecar (`RemoteController`,
 * M2b) hält die PeerConnection und injiziert Input (M2c). Diese Brücke ist nur
 * der Bote zwischen dem Signaling-Store (WS) und dem Sidecar über die
 * Electron-Bridge `window.pulse.gsr.remote*`:
 *
 *   Store (WS) ──_signal(offer/ice)──▶ handleSignal ──gsr.remoteSignal──▶ Sidecar
 *   Sidecar ──remote_signal-Event(answer/ice)──▶ onEvent ──sendSignal──▶ Store (WS)
 *   Sidecar ──remote_state('connected')──▶ markActive
 *
 * Läuft nur in Electron (der Host MUSS die Desktop-App + Sidecar haben). Ohne
 * Bridge (reiner Browser) kann der User nicht Host sein → Session beenden.
 */

import { remoteSession, type RemoteRole, type RemoteWebrtc } from './session.svelte';
import type { RemoteSignalKind } from '$lib/ws/gateway-senders';
import { getIceServers } from './iceConfig';

/** Das vom Sidecar emittierte Event, das uns interessiert. */
type SidecarEvent = { ev?: string; kind?: string; data?: string; state?: string };

class RemoteHostBridge implements RemoteWebrtc {
  #unsub: (() => void) | null = null;

  start(_sessionId: string, role: RemoteRole): void {
    if (role !== 'host') return; // Controller-Rolle fährt der Browser (Scheibe 3)
    const gsr = window.pulse?.gsr;
    if (!gsr) {
      // Kein Sidecar erreichbar → dieser Client kann nicht Host sein.
      console.warn('[remote] Host-Rolle ohne Sidecar-Bridge — Session wird beendet');
      remoteSession.end();
      return;
    }
    // Sidecar-Events abgreifen: Answer/ICE zurück an den Controller, Zustand melden.
    this.#unsub = gsr.onEvent((raw) => this.#onSidecar(raw as SidecarEvent));
    void gsr.remoteStart({ ice_servers: getIceServers() });
  }

  handleSignal(kind: RemoteSignalKind, data: string): void {
    // Offer/ICE des Controllers an den Sidecar durchreichen.
    void window.pulse?.gsr?.remoteSignal(kind, data);
  }

  stop(): void {
    this.#unsub?.();
    this.#unsub = null;
    void window.pulse?.gsr?.remoteStop();
  }

  #onSidecar(ev: SidecarEvent): void {
    if (ev.ev === 'remote_signal' && ev.kind && ev.data !== undefined) {
      // Der Sidecar erzeugt Answer + eigene ICE-Kandidaten → an den Controller.
      remoteSession.sendSignal(ev.kind as RemoteSignalKind, ev.data);
    } else if (ev.ev === 'remote_state' && ev.state === 'connected') {
      remoteSession.markActive();
    }
  }
}

export const remoteHostBridge = new RemoteHostBridge();
