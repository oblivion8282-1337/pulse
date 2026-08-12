/**
 * Fernsteuerung — Session-Store / Consent-Zustandsmaschine.
 *
 * Treibt ausschließlich den Consent-Handshake (Anfrage → Zustimmung/Ablehnung
 * → Beenden) über die App-WebSocket. Video und Eingabe laufen komplett daneben
 * (nativer Player / win-hq-sidecar über den `remote_input`-Serverweg, s.
 * `docs/plans/2026-08-12-input-wire-protokoll-v2.md`) — dieser Store kennt kein
 * WebRTC und keine Verhandlungsphase: eine Zustimmung schaltet direkt auf
 * `'active'`.
 *
 * Op-Fluss (Gegenstück zu `ws_remote_handlers.py`):
 *   Controller  request()        → remote_request  → Host: _incomingRequest → phase 'incoming'
 *   Host        accept()/deny()   → remote_respond
 *   beide       remote_response   → _response → phase 'active' (oder Reset bei Ablehnung)
 *   beide       end()/remote_ended→ Teardown
 */

import { gateway } from '$lib/ws/connection';
import { eingabeFreigeben } from './sidecarInput';

export type RemotePhase = 'idle' | 'requesting' | 'incoming' | 'active';
export type RemoteRole = 'controller' | 'host';

/** Wie oft geprüft wird, ob die Verbindung noch steht (nur während einer
 *  Sitzung). `gateway.state` ist keine Rune, also gibt es dafür keinen Effect;
 *  1 Hz reicht — dieselbe Taktung nutzt `ws/server-state.svelte.ts`. */
const VERBINDUNGS_TAKT_MS = 1000;

class RemoteSessionStore {
  phase = $state<RemotePhase>('idle');
  role = $state<RemoteRole | null>(null);
  sessionId = $state<string | null>(null);
  /** Gegenüber: beim Controller der Host, beim Host der Controller. */
  peerUserId = $state<string | null>(null);
  channelId = $state<string | null>(null);
  /**
   * Welcher der gleichzeitig laufenden Streams des Hosts gesteuert wird
   * (Wire-Protokoll v2, „Der `slot`"). Nur beim Steuernden gesetzt: er wählt
   * ihn mit der Kachel, an der er die Anfrage stellt. Der Host braucht ihn
   * nicht — dort steht er in jeder einzelnen Nachricht.
   */
  targetSlot = $state(0);
  /** Zuletzt aufgetretener Fehler (bleibt bis zur nächsten Anfrage sichtbar). */
  error = $state<string | null>(null);

  #errUnsub: (() => void) | null = null;
  #verbindungsWacht: ReturnType<typeof setInterval> | null = null;

  // ── Controller-Seite ──────────────────────────────────────────────────────
  request(channelId: string, hostUserId: string, slot = 0): void {
    if (this.phase !== 'idle') return;
    this.error = null;
    this.role = 'controller';
    this.peerUserId = hostUserId;
    this.channelId = channelId;
    this.targetSlot = slot;
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
    // Übergang nach 'active' macht das remote_response-Echo (beide Peers
    // laufen denselben Pfad), damit Host und Controller synchron umschalten.
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
    this.#reset();
  }

  // ── Inbound (vom Handler-Modul `handlers/remote.ts`) ──────────────────────
  _incomingRequest(sessionId: string, channelId: string, fromUserId: string): void {
    if (this.phase !== 'idle') return; // schon beschäftigt — Server-Gate (4054) deckt das ab
    this.error = null;
    this.role = 'host';
    this.sessionId = sessionId;
    this.channelId = channelId;
    this.peerUserId = fromUserId;
    this.targetSlot = 0; // Host-Seite: der Slot steht in jeder einzelnen Nachricht.
    this.phase = 'incoming';
  }

  _response(sessionId: string, accepted: boolean): void {
    // Eine Response ist nur zu erwarten, solange wir wirklich darauf warten:
    // Controller in 'requesting', Host in 'incoming'. Ein Duplikat/verspätetes
    // Echo im 'active'-Zustand würde sonst eine tote Session wiederbeleben.
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
    this.phase = 'active';
    this.#watchVerbindung();
  }

  _ended(sessionId: string, _reason: string): void {
    if (sessionId !== this.sessionId) return;
    this.#reset();
  }

  /** Eine andere Host-Tab hat die Anfrage schon beantwortet — nur den offenen
   *  Consent-Dialog dieser Tab schließen. */
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
  #reset(): void {
    this.#unwatchErrors();
    this.#unwatchVerbindung();
    // „Alles loslassen beim Ende" (Wire-Spec) — hier, weil #reset der EINZIGE
    // Ausgang aus jeder Sitzung ist: reguläres Beenden, Ablehnung, Gegenüber
    // weg, Verbindungsverlust, Fehler. Ohne diesen Ruf liefe nach einem
    // Abbruch die W-Taste im Spiel für immer weiter. Idempotent und ohne
    // laufende Eingabe-Sitzung folgenlos, deshalb ungefiltert nach Rolle: der
    // Host ist der einzige, der je eine hatte.
    void eingabeFreigeben();
    this.phase = 'idle';
    this.role = null;
    this.sessionId = null;
    this.peerUserId = null;
    this.channelId = null;
    this.targetSlot = 0;
    // `error` bleibt bewusst stehen — die UI zeigt ihn bis zur nächsten Anfrage.
  }

  /**
   * Verbindung weg = Sitzung weg.
   *
   * Der Gateway beendet jede Sitzung eines abgerissenen Sockets sofort und
   * ohne Schonfrist (`cleanup_remote_on_disconnect`) — nur erfährt genau die
   * Seite, deren Socket abriss, davon nichts mehr. Ohne diese Wacht bliebe
   * beim Host das Warnbanner stehen, beim Steuernden liefe die Erfassung
   * weiter, und der Sidecar hielte alles Gedrückte fest.
   *
   * Poll statt Effect, weil `gateway.state` bewusst keine Rune ist (s.
   * `ws/gateway-connection.ts`) — dieselbe Begründung wie in
   * `ws/server-state.svelte.ts`.
   */
  #watchVerbindung(): void {
    this.#unwatchVerbindung();
    this.#verbindungsWacht = setInterval(() => {
      let offen = false;
      try {
        offen = gateway.state === 'open';
      } catch {
        offen = false; // kein aktiver Server mehr (abgemeldet / Server entfernt)
      }
      if (!offen) this.#reset();
    }, VERBINDUNGS_TAKT_MS);
  }

  #unwatchVerbindung(): void {
    if (this.#verbindungsWacht !== null) {
      clearInterval(this.#verbindungsWacht);
      this.#verbindungsWacht = null;
    }
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
