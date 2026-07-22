/**
 * Fernsteuerung — Session-Store / Signaling-Zustandsmaschine (M3, Scheibe 2).
 *
 * Treibt den Consent-Handshake und den Signaling-Zustand; das eigentliche
 * WebRTC (Video empfangen, Input senden) hängt sich als `RemoteWebrtc` über
 * `attachWebrtc()` ein (Scheibe 3) — so bleibt die Zustandsmaschine für sich
 * testbar und der Media-Teil austauschbar.
 *
 * Op-Fluss (Gegenstück zu `ws_remote_handlers.py`):
 *   Controller  request()        → remote_request  → Host: _incomingRequest → phase 'incoming'
 *   Host        accept()/deny()   → remote_respond
 *   beide       remote_response   → _response → phase 'connecting' (WebRTC start)
 *   beide       remote_signal     ↔ SDP/ICE (sendSignal / _signal)
 *   beide       end()/remote_ended→ Teardown
 */

import { gateway } from '$lib/ws/connection';
import type { RemoteSignalKind } from '$lib/ws/gateway-senders';
import { refreshIceServers } from './iceConfig';

export type RemotePhase = 'idle' | 'requesting' | 'incoming' | 'connecting' | 'active';
export type RemoteRole = 'controller' | 'host';

/** Scheibe-3-Naht: der WebRTC-Controller implementiert das und ruft `attachWebrtc`. */
export interface RemoteWebrtc {
  /** Verhandlung starten. Der Controller ist der Offerer (s. Wire-Spec). */
  start(sessionId: string, role: RemoteRole): void;
  /** Eingehendes SDP/ICE vom Peer. */
  handleSignal(kind: RemoteSignalKind, data: string): void;
  /** Verbindung abbauen (Session-Ende, egal welcher Grund). */
  stop(): void;
}

class RemoteSessionStore {
  phase = $state<RemotePhase>('idle');
  role = $state<RemoteRole | null>(null);
  sessionId = $state<string | null>(null);
  /** Gegenüber: beim Controller der Host, beim Host der Controller. */
  peerUserId = $state<string | null>(null);
  channelId = $state<string | null>(null);
  /** Zuletzt aufgetretener Fehler (bleibt bis zur nächsten Anfrage sichtbar). */
  error = $state<string | null>(null);

  #webrtc: RemoteWebrtc | null = null;
  #errUnsub: (() => void) | null = null;

  /** Der WebRTC-Controller (Scheibe 3) hängt sich hier ein. */
  attachWebrtc(webrtc: RemoteWebrtc): void {
    this.#webrtc = webrtc;
  }

  // ── Controller-Seite ──────────────────────────────────────────────────────
  request(channelId: string, hostUserId: string): void {
    if (this.phase !== 'idle') return;
    this.error = null;
    this.role = 'controller';
    this.peerUserId = hostUserId;
    this.channelId = channelId;
    this.sessionId = null; // vergibt der Server, kommt erst mit remote_response
    this.phase = 'requesting';
    this.#watchErrors(); // Host offline / belegt → op:'error' abfangen
    gateway.sendRemoteRequest(channelId, hostUserId);
  }

  /** Anfrage abbrechen, während noch auf die Freigabe gewartet wird. */
  cancel(): void {
    if (this.phase === 'requesting') this.#reset();
  }

  // ── Host-Seite ────────────────────────────────────────────────────────────
  accept(): void {
    if (this.phase !== 'incoming' || !this.sessionId) return;
    // Übergang nach 'connecting' macht das remote_response-Echo (beide Peers
    // laufen denselben Pfad), damit Host und Controller synchron starten.
    gateway.sendRemoteRespond(this.sessionId, true);
  }

  deny(): void {
    if (this.phase !== 'incoming' || !this.sessionId) return;
    gateway.sendRemoteRespond(this.sessionId, false);
    this.#reset();
  }

  // ── Beide ─────────────────────────────────────────────────────────────────
  end(): void {
    if (this.sessionId) gateway.sendRemoteEnd(this.sessionId);
    this.#teardown();
  }

  /** Der WebRTC-Controller meldet „Peer verbunden". */
  markActive(): void {
    if (this.phase === 'connecting') this.phase = 'active';
  }

  /** Ausgehendes SDP/ICE — vom WebRTC-Controller aufgerufen. */
  sendSignal(kind: RemoteSignalKind, data: string): void {
    if (this.sessionId) gateway.sendRemoteSignal(this.sessionId, kind, data);
  }

  // ── Inbound (vom Handler-Modul `handlers/remote.ts`) ──────────────────────
  _incomingRequest(sessionId: string, channelId: string, fromUserId: string): void {
    if (this.phase !== 'idle') return; // schon beschäftigt — Server-Gate (4054) deckt das ab
    this.error = null;
    this.role = 'host';
    this.sessionId = sessionId;
    this.channelId = channelId;
    this.peerUserId = fromUserId;
    this.phase = 'incoming';
  }

  _response(sessionId: string, accepted: boolean): void {
    // Eine Response ist nur zu erwarten, solange wir wirklich darauf warten:
    // Controller in 'requesting', Host in 'incoming'. Ein Duplikat/verspätetes
    // Echo im 'active'/'connecting'-Zustand würde sonst `start()` erneut auslösen
    // (reißt die laufende PC ab) oder eine tote Session wiederbeleben.
    if (this.phase !== 'requesting' && this.phase !== 'incoming') return;
    // Der Controller kennt seine sessionId erst hier (der Server vergibt sie).
    if (this.sessionId !== null && sessionId !== this.sessionId) return;
    if (this.role === null) return;
    this.sessionId = sessionId;
    this.#unwatchErrors();
    if (!accepted) {
      this.error = 'Anfrage abgelehnt.';
      this.#reset();
      return;
    }
    this.phase = 'connecting';
    // Frische ICE-Server (inkl. kurzlebiger TURN-Creds) holen, DANN starten —
    // beide Seiten (Controller + Host-Sidecar) lesen `getIceServers()` beim
    // Start. Wird die Session währenddessen beendet ODER durch eine neue ersetzt,
    // nicht mehr starten (sessionId + role prüfen, nicht nur die Phase).
    const role = this.role;
    void refreshIceServers().finally(() => {
      if (this.phase === 'connecting' && this.sessionId === sessionId && this.role === role) {
        this.#webrtc?.start(sessionId, role);
      }
    });
  }

  _signal(sessionId: string, kind: RemoteSignalKind, data: string): void {
    if (sessionId !== this.sessionId) return;
    this.#webrtc?.handleSignal(kind, data);
  }

  _ended(sessionId: string, _reason: string): void {
    if (sessionId !== this.sessionId) return;
    this.#teardown();
  }

  /** Eine andere Host-Tab hat die Anfrage schon beantwortet — nur den offenen
   *  Consent-Dialog dieser Tab schließen (kein WebRTC lief hier). */
  _dismissIncoming(sessionId: string): void {
    if (this.phase === 'incoming' && this.role === 'host' && sessionId === this.sessionId) {
      this.#reset();
    }
  }

  _error(code: number, msg: string): void {
    if (this.phase !== 'requesting') return;
    this.error = remoteErrorMessage(code, msg);
    this.#reset();
  }

  // ── intern ────────────────────────────────────────────────────────────────
  #teardown(): void {
    this.#webrtc?.stop();
    this.#reset();
  }

  #reset(): void {
    this.#unwatchErrors();
    this.phase = 'idle';
    this.role = null;
    this.sessionId = null;
    this.peerUserId = null;
    this.channelId = null;
    // `error` bleibt bewusst stehen — die UI zeigt ihn bis zur nächsten Anfrage.
  }

  #watchErrors(): void {
    this.#unwatchErrors();
    this.#errUnsub = gateway.on((evt) => {
      // NUR die Fernsteuerungs-Fehlercodes (4050–4059) — sonst würde ein
      // beliebiger anderer `error`-Frame (fehlgeschlagener Chat-Send, Rate-Limit)
      // im langen Warte-auf-Consent-Fenster die Anfrage fälschlich abbrechen.
      if (evt.op === 'error' && evt.code >= 4050 && evt.code <= 4059) {
        this._error(evt.code, evt.msg);
      }
    });
  }

  #unwatchErrors(): void {
    this.#errUnsub?.();
    this.#errUnsub = null;
  }
}

/** Consent-/Erreichbarkeits-Fehlercodes (s. `ws_remote_handlers.py`). */
function remoteErrorMessage(code: number, fallback: string): string {
  switch (code) {
    case 4051:
      return 'Keine Berechtigung für Fernsteuerung in diesem Kanal.';
    case 4052:
      return 'Der Host ist gerade nicht erreichbar.';
    case 4054:
      return 'Der Host hat bereits eine aktive Fernsteuerungs-Sitzung.';
    default:
      return fallback || 'Fernsteuerung fehlgeschlagen.';
  }
}

export const remoteSession = new RemoteSessionStore();
