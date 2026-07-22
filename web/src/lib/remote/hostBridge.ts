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
import { runningStreamSlots } from '$lib/stream/state.svelte';
import type { RemoteSignalKind } from '$lib/ws/gateway-senders';
import { getIceServers } from './iceConfig';

/** Das vom Sidecar emittierte Event, das uns interessiert. Der Main-Prozess
 *  taggt jedes Event mit seinem `slot` (ein Sidecar-Prozess pro Slot). */
type SidecarEvent = { ev?: string; kind?: string; data?: string; state?: string; slot?: number };

class RemoteHostBridge implements RemoteWebrtc {
  #unsub: (() => void) | null = null;
  /** Ist `remote_start` beim Sidecar durch? Erst dann Signale weiterreichen. */
  #started = false;
  /** Signale, die vor dem Durchkommen von `remote_start` ankamen (Ordering-Race:
   *  der Controller schickt sein Offer evtl. schneller als unser `remoteStart`). */
  #pending: Array<[RemoteSignalKind, string]> = [];
  /** Stream-Slot, auf dem der Host streamt — jeder Slot ist ein eigener Sidecar-
   *  Prozess, und der Tee hängt an DESSEN Encoder. Fest verankert am Session-Start. */
  #slot = 0;

  start(_sessionId: string, role: RemoteRole): void {
    if (role !== 'host') return; // Controller-Rolle fährt der Browser (Scheibe 3)
    const gsr = window.pulse?.gsr;
    if (!gsr) {
      // Kein Sidecar erreichbar → dieser Client kann nicht Host sein.
      console.warn('[remote] Host-Rolle ohne Sidecar-Bridge — Session wird beendet');
      remoteSession.end();
      return;
    }
    this.#started = false;
    this.#pending = [];
    // Den Prozess ansprechen, der wirklich streamt (nicht stur Slot 0) — sonst
    // landet remote_start im leeren Slot-0-Prozess → Schwarzbild + toter Input.
    this.#slot = runningStreamSlots()[0] ?? 0;
    // Sidecar-Events abgreifen: Answer/ICE zurück an den Controller, Zustand melden.
    this.#unsub = gsr.onEvent((raw) => this.#onSidecar(raw as SidecarEvent));
    gsr
      .remoteStart({ ice_servers: getIceServers() }, this.#slot)
      .then(() => {
        // Jetzt existiert die Sidecar-Session — gepufferte Signale nachreichen.
        this.#started = true;
        for (const [kind, data] of this.#pending) void gsr.remoteSignal(kind, data, this.#slot);
        this.#pending = [];
      })
      .catch((e: unknown) => {
        // Sidecar lehnte ab (z.B. kein H.264-Stream) → Session beenden.
        console.warn('[remote] remote_start abgelehnt', e);
        remoteSession.end();
      });
  }

  handleSignal(kind: RemoteSignalKind, data: string): void {
    const gsr = window.pulse?.gsr;
    if (!gsr) return;
    // Vor `remote_start` puffern (sonst wirft der Sidecar „keine Session"), danach
    // direkt durchreichen — die Ops laufen über stdin geordnet.
    if (!this.#started) {
      this.#pending.push([kind, data]);
      return;
    }
    void gsr.remoteSignal(kind, data, this.#slot);
  }

  stop(): void {
    this.#unsub?.();
    this.#unsub = null;
    this.#started = false;
    this.#pending = [];
    void window.pulse?.gsr?.remoteStop(this.#slot);
  }

  #onSidecar(ev: SidecarEvent): void {
    // Nur Events vom Slot, auf dem unsere Remote-Session läuft — ein anderer
    // parallel streamender Slot darf uns nicht ins Signaling funken.
    if (ev.slot !== undefined && ev.slot !== this.#slot) return;
    if (ev.ev === 'remote_signal' && ev.kind && ev.data !== undefined) {
      // Der Sidecar erzeugt Answer + eigene ICE-Kandidaten → an den Controller.
      remoteSession.sendSignal(ev.kind as RemoteSignalKind, ev.data);
    } else if (ev.ev === 'remote_state') {
      // 'connected' → aktiv; terminale Zustände → Session beenden (Backstop, damit
      // ein Verbindungsverlust am Host nicht als „aktiv" hängen bleibt).
      if (ev.state === 'connected') remoteSession.markActive();
      else if (ev.state === 'failed' || ev.state === 'closed') remoteSession.end();
    }
  }
}

export const remoteHostBridge = new RemoteHostBridge();
