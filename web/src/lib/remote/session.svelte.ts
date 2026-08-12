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

import { activeGatewayConnection, gatewayForServer } from '$lib/ws/connection';
import type { GatewayConnection } from '$lib/ws/connection';
import { dispatchingServerId } from '$lib/ws/gateway-connection';
import { m } from '$lib/paraglide/messages.js';
import { eingabeFreigeben } from './sidecarInput';
import { WachtSchalter, anfrageFrist, fehlerWacht, verbindungsWacht } from './wachten';

export type RemotePhase = 'idle' | 'requesting' | 'incoming' | 'active';
export type RemoteRole = 'controller' | 'host';

/** Wie oft geprüft wird, ob die Verbindung noch steht (nur während einer
 *  Sitzung). Der Verbindungszustand ist keine Rune, also gibt es dafür keinen
 *  Effect; 1 Hz reicht — dieselbe Taktung nutzt `ws/server-state.svelte.ts`. */
const VERBINDUNGS_TAKT_MS = 1000;

/**
 * Wie lange eine unbeantwortete Anfrage stehen bleibt — auf BEIDEN Seiten.
 *
 * Der Gateway räumt sie nach 30 s ab
 * (`remote_registry.py::REMOTE_PENDING_TIMEOUT_S`), meldet das aber nur dem
 * Steuernden (`remote_ended`, reason 'timeout') und dem Host gar nicht. Diese
 * Frist liegt bewusst darüber und ist das Netz für beides: für den Steuernden,
 * falls die Meldung ausbleibt, und für den Host, dessen Consent-Dialog sonst
 * nach dem Verfall offen stehen bliebe. Ohne das Netz wartet der Steuernde
 * unbegrenzt — und weil `request()` in jedem anderen Zustand früh
 * zurückspringt, ist so lange jeder weitere Anfrage-Knopf tot.
 */
const ANFRAGE_FRIST_MS = 40_000;

/** Dieselbe Lage aus zwei Quellen: die eigene Frist oben und das
 *  `remote_ended`(timeout) des Gateways. Deshalb einmal benannt — sonst
 *  bekommt der Nutzer je nachdem, wer zuerst zuschlägt, einen anderen Wortlaut,
 *  sobald jemand nur eine der beiden Stellen umformuliert. */
const KEINE_ANTWORT = 'Der Host hat nicht geantwortet.';

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
  /**
   * Zuletzt aufgetretener Fehler. Wird von `RemoteErrorToast` **einmal**
   * angezeigt und dabei sofort wieder auf `null` gesetzt — der Store selbst
   * löscht ihn nur beim Start der nächsten Anfrage, damit auch ein Fehler, der
   * vor dem Mount des Toasts entsteht, noch ankommt.
   */
  error = $state<string | null>(null);

  /** Die drei Wachten der Sitzung (`wachten.ts`), jede in ihrem An/Aus-Halter. */
  readonly #fehler = new WachtSchalter();
  readonly #verbindung = new WachtSchalter();
  readonly #frist = new WachtSchalter();
  /**
   * Die Verbindung, auf der DIESE Sitzung zustande kam — einmal festgehalten,
   * statt bei jedem Ruf neu aufgelöst.
   *
   * `gateway` aus `ws/connection` zeigt immer auf den GERADE aktiven Server.
   * Wechselt der Nutzer während einer laufenden Fernsteuerung den Server,
   * gingen `remote_input`-Frames samt `session_id` an einen fremden Gateway
   * (der sie mit 4053 abweist), und die Wachten beurteilten eine Verbindung,
   * die mit der Sitzung nichts zu tun hat. Muster wie `cloudGateway` (DMs).
   */
  #conn: GatewayConnection | null = null;

  // ── Controller-Seite ──────────────────────────────────────────────────────
  request(channelId: string, hostUserId: string, slot = 0): void {
    if (this.phase !== 'idle') return;
    this.error = null;
    let conn: GatewayConnection;
    try {
      conn = activeGatewayConnection();
    } catch {
      // Kein aktiver Server (abgemeldet, Eintrag entfernt) — der Proxy wirft.
      this.error = m.remote_error_offline();
      return;
    }
    // ERST senden, DANN den Zustand setzen.
    //
    // `sendRemoteRequest` liefert `false`, wenn die WebSocket gerade nicht
    // offen ist — still, ohne Ausnahme. Wurde der Zustand vorher auf
    // 'requesting' gesetzt, bleibt er dort für immer hängen: die Antwort, die
    // ihn auflösen würde, kann nicht kommen, weil die Anfrage nie hinausging.
    // Und weil oben `phase !== 'idle'` früh zurückspringt, ist damit JEDER
    // weitere Klick wirkungslos — der Knopf ist tot bis zum Neuladen.
    //
    // Genau so am 2026-08-12 im Zwei-Geräte-Test aufgelaufen, nach einem
    // Neustart des Gateways: geklickt, während die Verbindung noch neu
    // aufgebaut wurde. Von außen sah es aus, als täte der Knopf nichts.
    if (!conn.sendRemoteRequest(channelId, hostUserId)) {
      this.error = m.remote_error_offline();
      return;
    }
    this.#conn = conn;
    this.role = 'controller';
    this.peerUserId = hostUserId;
    this.channelId = channelId;
    this.targetSlot = slot;
    this.sessionId = null; // vergibt der Server, kommt erst mit remote_response
    this.phase = 'requesting';
    this.#watchErrors(); // Host offline / belegt → op:'error' abfangen
    this.#watchFrist(); // unbeantwortete Anfrage nicht ewig stehen lassen
  }

  /** Anfrage abbrechen, während noch auf die Freigabe gewartet wird. */
  cancel(): void {
    if (this.phase === 'requesting') this.#reset();
  }

  /**
   * Eingabe-Frames auf der Verbindung DIESER Sitzung absetzen — der Weg über
   * den Store statt direkt über `gateway`, denn nur hier ist bekannt,
   * auf welcher Verbindung die Sitzung läuft (s. `#conn`). `false` heißt „nicht
   * hinausgegangen" — kein Grund zu beenden; ein echter Abriss ist Sache der
   * Verbindungswacht. */
  sendInput(sessionId: string, slot: number, frames: string[]): boolean {
    if (this.phase !== 'active' || this.role !== 'controller') return false;
    if (!this.sessionId || sessionId !== this.sessionId) return false;
    return this.#senden((c) => c.sendRemoteInput(sessionId, slot, frames));
  }

  // ── Host-Seite ────────────────────────────────────────────────────────────
  accept(): void {
    if (this.phase !== 'incoming' || !this.sessionId) return;
    const id = this.sessionId;
    // ERST senden, DANN den Zustand ändern — dieselbe Regel wie beim Steuernden
    // in `request()`. Ging die Zustimmung nicht hinaus (Reconnect-Blip, Socket
    // gerade zu), bliebe die Phase auf 'incoming' stehen; daran hängt der
    // Consent-Dialog, und der hat nach dem Klick beide Knöpfe stillgelegt,
    // während Escape und Backdrop nur wieder `deny()` rufen würden — der Host
    // käme ausschließlich durch Neuladen der App wieder heraus. Fehlgeschlagen
    // heißt zugleich „die Anfrage ist ohnehin tot": ist der Socket zu, hat der
    // Gateway sie mit ihm abgeräumt (`cleanup_remote_on_disconnect`).
    if (!this.#senden((c) => c.sendRemoteRespond(id, true))) {
      this.error = m.remote_error_offline();
      this.#reset();
      return;
    }
    // Übergang nach 'active' macht das remote_response-Echo (beide Peers
    // laufen denselben Pfad), damit Host und Controller synchron umschalten.
  }

  deny(): void {
    if (this.phase !== 'incoming' || !this.sessionId) return;
    const id = this.sessionId;
    // Ergebnis absichtlich ungeprüft: ob die Ablehnung hinausging oder nicht,
    // das Ende ist dasselbe — keine Zustimmung. Entscheidend ist nur, dass ein
    // WURF des Senders das bedingungslose Aufräumen nicht überspringt; genau
    // dafür fängt `#senden` alles ab.
    this.#senden((c) => c.sendRemoteRespond(id, false));
    this.#reset();
  }

  // ── Beide ─────────────────────────────────────────────────────────────────
  end(): void {
    const id = this.sessionId;
    if (id) this.#senden((c) => c.sendRemoteEnd(id)); // s. `deny()`: Ende bleibt Ende
    this.#reset();
  }

  // ── Inbound (vom Handler-Modul `handlers/remote.ts`) ──────────────────────
  _incomingRequest(sessionId: string, channelId: string, fromUserId: string): void {
    if (this.phase !== 'idle') return; // schon beschäftigt — Server-Gate (4054) deckt das ab
    this.error = null;
    // Die Verbindung, über die die Anfrage hereinkam, festhalten: die Antwort
    // gehört auf dieselbe. Der Dispatch ist synchron (s. `dispatchingServerId`),
    // hier steht sie also noch. Ohne das ginge ein `accept` nach einem
    // Serverwechsel an einen Server, der die Sitzung nicht kennt.
    const von = dispatchingServerId();
    this.#conn = von ? gatewayForServer(von) : null;
    this.role = 'host';
    this.sessionId = sessionId;
    this.channelId = channelId;
    this.peerUserId = fromUserId;
    this.targetSlot = 0; // Host-Seite: der Slot steht in jeder einzelnen Nachricht.
    this.phase = 'incoming';
    // Auch der Host bekommt Frist und Fehler-Wacht: der Gateway räumt eine
    // unbeantwortete Anfrage nach 30 s ab, sagt das aber NUR dem Steuernden.
    // Ohne die beiden bliebe der Consent-Dialog danach offen stehen, und ein
    // später Klick auf „Erlauben" holte sich wortlos ein 4053 ab.
    this.#watchFrist('Die Anfrage ist abgelaufen.');
    this.#watchErrors();
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
    this.#fehler.aus();
    this.#frist.aus();
    if (!accepted) {
      this.error = 'Anfrage abgelehnt.';
      this.#reset();
      return;
    }
    this.phase = 'active';
    this.#watchVerbindung();
  }

  _ended(sessionId: string, reason: string): void {
    // Solange der Steuernde auf die Freigabe wartet, kennt er seine sessionId
    // NICHT — die vergibt der Server erst mit dem Echo. Genau in dieses Fenster
    // fällt aber das `remote_ended`(timeout) nach 30 s: verglichen mit `null`
    // passte es nie, und die Anfrage blieb für immer im Wartezustand stehen. In
    // diesem Zustand kann es nur die eigene Anfrage meinen — der Gateway
    // schickt es nur an die Beteiligten der Sitzung.
    if (this.sessionId === null) {
      if (this.phase !== 'requesting') return;
      if (reason === 'timeout') this.error = KEINE_ANTWORT;
      this.#reset();
      return;
    }
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
    // 'incoming' zählt mit: der Host bekommt auf eine Antwort zu einer schon
    // abgeräumten Anfrage ein 4053 — sonst bliebe sein Dialog stillgelegt offen.
    if (this.phase !== 'requesting' && this.phase !== 'incoming') return;
    this.error = remoteErrorMessage(code, msg);
    this.#reset();
  }

  // ── intern ────────────────────────────────────────────────────────────────

  /** Senden über die Verbindung DIESER Sitzung. `false` = nicht hinausgegangen.
   *  Fängt auch einen Wurf ab: die Aufrufer stehen in Pfaden, die danach noch
   *  aufräumen (`deny`, `end`) — eine durchgereichte Ausnahme übersprünge genau
   *  das und fröre die Oberfläche im Sitzungszustand ein. */
  #senden(fn: (c: GatewayConnection) => boolean): boolean {
    const c = this.#conn;
    if (!c) return false;
    try {
      return fn(c);
    } catch {
      return false;
    }
  }

  #reset(): void {
    this.#fehler.aus();
    this.#verbindung.aus();
    this.#frist.aus();
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
    this.#conn = null;
    // `error` bleibt bewusst stehen: er wird oft im selben Zug gesetzt, in dem
    // hier aufgeräumt wird (Ablehnung, Zeitablauf), und `RemoteErrorToast` holt
    // ihn erst im nächsten Effect ab — ihn hier zu löschen verschluckte genau
    // diese Meldungen. Gelöscht wird er beim Anzeigen und bei der nächsten Anfrage.
  }

  /** Verbindungsverlust beendet die Sitzung (Begründung in `wachten.ts`).
   *  Gemessen wird die Verbindung DIESER Sitzung: sonst beendete ein
   *  Server-Wechsel die Fernsteuerung — und umgekehrt liefe sie weiter, obwohl
   *  ihr eigener Träger längst weg wäre. */
  #watchVerbindung(): void {
    this.#verbindung.an(() =>
      verbindungsWacht(this.#conn, VERBINDUNGS_TAKT_MS, () => this.#reset()),
    );
  }

  /** Frist für eine unbeantwortete Anfrage (s. [`ANFRAGE_FRIST_MS`]) — beide
   *  Seiten, je mit ihrer Meldung. */
  #watchFrist(meldung = KEINE_ANTWORT): void {
    this.#frist.an(() =>
      anfrageFrist(ANFRAGE_FRIST_MS, () => {
        if (this.phase !== 'requesting' && this.phase !== 'incoming') return;
        this.error = meldung;
        this.#reset();
      }),
    );
  }

  /** Abonniert wird auf der Verbindung DIESER Anfrage — ein `op:'error'` eines
   *  anderen Servers geht die Fernsteuerung nichts an. */
  #watchErrors(): void {
    this.#fehler.an(() => fehlerWacht(this.#conn, (code, msg) => this._error(code, msg)));
  }
}

/** Consent-/Erreichbarkeits-Fehlercodes (s. `ws_remote_handlers.py`). */
function remoteErrorMessage(code: number, fallback: string): string {
  switch (code) {
    case 4051:
      return 'Keine Berechtigung für Fernsteuerung in diesem Kanal.';
    case 4052:
      return 'Der Host ist gerade nicht erreichbar.';
    case 4053:
      // Die Sitzung/Anfrage gibt es nicht mehr — beim Host der Fall, wenn er
      // erst antwortet, nachdem der Gateway die Anfrage hat verfallen lassen.
      return 'Die Anfrage ist nicht mehr gültig.';
    case 4054:
      return 'Der Host hat bereits eine aktive Fernsteuerungs-Sitzung.';
    case 4055: {
      // Sperrfrist nach Absage/Aussitzen. Der Server schreibt die Restzeit in
      // den englischen Text ("retry in 12s") — die ist die einzige Auskunft,
      // die dem Wartenden hilft, deshalb wird sie herausgelesen statt mit dem
      // Text verworfen. Fehlt sie (anderer Wortlaut), bleibt die Aussage wahr.
      const restS = Number(/(\d+)\s*s/.exec(fallback)?.[1]);
      return Number.isFinite(restS)
        ? `Der Host hat gerade abgelehnt. Erneut möglich in ${restS} Sekunden.`
        : 'Der Host hat gerade abgelehnt. Bitte kurz warten.';
    }
    default:
      return fallback || 'Fernsteuerung fehlgeschlagen.';
  }
}

export const remoteSession = new RemoteSessionStore();
