/**
 * Fernsteuerung — WebRTC-Controller (M3, Scheibe 3).
 *
 * Die Browser-Seite des **Controllers** (wer steuert): baut die
 * `RTCPeerConnection`, empfängt den H.264-Bildschirm des Hosts und eröffnet den
 * Input-DataChannel. Der Controller ist der **Offerer** (s. Wire-Spec), fährt
 * **Trickle-ICE** (Offer sofort, Kandidaten einzeln) — passend zum webrtc-rs-Host
 * (`pulse-remote-webrtc`), der Answer + ICE über `remote_signal` zurückschickt.
 *
 * Interop-Format (mit `pulse-remote-webrtc` abgestimmt):
 *   - offer/answer: **rohes SDP** im `data`-Feld.
 *   - ice: **JSON von `RTCIceCandidateInit`** (`candidate`/`sdpMid`/…) — genau
 *     das, was der Browser aus `candidate.toJSON()` erzeugt und in
 *     `addIceCandidate` frisst.
 *
 * Die **Host-Rolle** läuft NICHT hier, sondern im Sidecar (`RemoteController`,
 * M2b) über die Electron-Brücke (Scheibe 6) — deshalb macht `start()` bei
 * `role !== 'controller'` nichts.
 *
 * `stop()` ist idempotent; jeder Fehler im Aufbau endet die Session sauber.
 */

import { remoteSession, type RemoteRole, type RemoteWebrtc } from './session.svelte';
import type { RemoteSignalKind } from '$lib/ws/gateway-senders';
import { helloFrame } from './input';

// TURN ist Pflicht (Consumer↔Consumer scheitert direkt, s. Handoff); die
// regionalen coturn-Server kommen später vom Server (wie das WHEP-Token).
// Bis dahin nur STUN — reicht für gleiches-Netz-/Server-reflexive-Fälle.
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

class RemoteControllerWebrtc implements RemoteWebrtc {
  /** Empfangener Host-Bildschirm — die Viewer-UI hängt ihn an ein `<video>`. */
  stream = $state<MediaStream | null>(null);
  /** Input-Kanal offen? Erst dann ist Steuern sinnvoll (Scheibe 4 gated darauf). */
  inputOpen = $state(false);

  #pc: RTCPeerConnection | null = null;
  #input: RTCDataChannel | null = null;
  #iceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS;

  /** ICE-Server setzen (z.B. TURN vom Server), bevor eine Session startet. */
  setIceServers(servers: RTCIceServer[]): void {
    this.#iceServers = servers;
  }

  async start(_sessionId: string, role: RemoteRole): Promise<void> {
    if (role !== 'controller') return; // Host-Rolle fährt der Sidecar (Scheibe 6)
    this.stop(); // defensiv gegen eine hängende Vorsession
    try {
      const pc = new RTCPeerConnection({ iceServers: this.#iceServers });
      this.#pc = pc;
      // Wir empfangen nur Video (der Host teet den H.264-Bildschirm). Kein Audio.
      pc.addTransceiver('video', { direction: 'recvonly' });

      // Input-Kanal: der Controller eröffnet ihn, reliable + ordered (Defaults —
      // KEINE maxRetransmits/ordered:false). Reihenfolge Move→Klick ist tragend.
      const dc = pc.createDataChannel('input', { ordered: true });
      dc.binaryType = 'arraybuffer';
      this.#input = dc;
      dc.onopen = () => {
        dc.send(helloFrame()); // Hello MUSS die erste Nachricht sein (Wire-Spec).
        this.inputOpen = true;
      };
      dc.onclose = () => {
        this.inputOpen = false;
      };

      pc.ontrack = (e) => {
        this.stream = e.streams[0] ?? new MediaStream([e.track]);
      };
      pc.onicecandidate = (e) => {
        if (e.candidate) remoteSession.sendSignal('ice', JSON.stringify(e.candidate.toJSON()));
      };
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'connected') remoteSession.markActive();
        else if (s === 'failed' || s === 'disconnected' || s === 'closed') remoteSession.end();
      };

      // Trickle: Offer SOFORT schicken, nicht auf ICE-Gathering warten.
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      remoteSession.sendSignal('offer', offer.sdp ?? '');
    } catch (e) {
      console.error('[remote] WebRTC-Start fehlgeschlagen', e);
      remoteSession.end();
    }
  }

  async handleSignal(kind: RemoteSignalKind, data: string): Promise<void> {
    const pc = this.#pc;
    if (!pc) return;
    try {
      if (kind === 'answer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: data });
      } else if (kind === 'ice') {
        await pc.addIceCandidate(JSON.parse(data) as RTCIceCandidateInit);
      }
      // 'offer' erreicht den Controller nie (er ist der Offerer).
    } catch (e) {
      console.warn(`[remote] Signal '${kind}' verarbeiten fehlgeschlagen`, e);
    }
  }

  /** Einen Input-Frame senden (Scheibe 4 ruft das). No-op, wenn der Kanal zu ist. */
  sendInput(frame: Uint8Array<ArrayBuffer>): void {
    const dc = this.#input;
    if (dc && dc.readyState === 'open') dc.send(frame);
  }

  /** Gepufferte Bytes im Input-Kanal — Scheibe 4 droppt Moves über der Schwelle. */
  inputBufferedAmount(): number {
    return this.#input?.bufferedAmount ?? 0;
  }

  /** `close()` schlucken (ein zugemachter Kanal/PC wirft) und `null` liefern. */
  #closeQuietly(x: { close(): void } | null): null {
    try {
      x?.close();
    } catch {
      /* egal */
    }
    return null;
  }

  stop(): void {
    this.inputOpen = false;
    this.stream = null;
    this.#input = this.#closeQuietly(this.#input);
    this.#pc = this.#closeQuietly(this.#pc);
  }
}

export const remoteController = new RemoteControllerWebrtc();
// Beim ersten Import an den Store hängen — die Controller-Rolle ist damit
// aktiv (Video empfangen + Input senden). Die Host-Rolle registriert Scheibe 6
// separat (Sidecar-Brücke).
remoteSession.attachWebrtc(remoteController);
