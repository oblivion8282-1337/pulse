/**
 * Fernsteuerung — Session-Store / Consent-Zustandsmaschine.
 *
 * Treibt den Consent-Handshake (Anfrage → Zustimmung/Ablehnung → Beenden)
 * über die App-WebSocket. Video läuft komplett daneben (nativer Player /
 * win-hq-sidecar); die Eingabe geht über den `remote_input`-Serverweg
 * (`docs/plans/2026-08-12-input-wire-protokoll-v2.md`) und — sobald der
 * DataChannel steht — direkt zwischen den Renderern (`p2p.ts`, Stufe 1 des
 * P2P-Plans). Eine Verhandlungsphase gibt es weiterhin nicht: die Zustimmung
 * schaltet direkt auf `'active'`, der Kanalaufbau läuft daneben, und bis er
 * trägt (oder falls nie), trägt der Serverweg.
 *
 * Op-Fluss (Gegenstück zu `ws_remote_handlers.py`):
 *   Controller  request()        → remote_request  → Host: _incomingRequest → phase 'incoming'
 *   Gateway     remote_pending    → _pending → der Steuernde kennt seine session_id
 *   Host        accept()/deny()   → remote_respond
 *   beide       remote_response   → _response → phase 'active' (oder Reset bei Ablehnung)
 *   beide       end()/remote_ended→ Teardown
 *
 * **Die Sitzungskennung ist die einzige Zuordnung.** Jeder hereinkommende
 * `remote_*`-Frame wird gegen die gemerkte `sessionId` geprüft; was nicht passt,
 * wird verworfen. Ohne diese Prüfung übernahm eine Zustimmung zu einer längst
 * abgebrochenen Anfrage die frische Anfrage an jemand anderen — Maus und
 * Tastatur zielten auf das Bild des einen und wirkten auf dem Rechner des
 * anderen (Prüflauf 2026-08-12, F1).
 */

import { activeGatewayConnection } from '$lib/ws/connection';
import type { GatewayConnection } from '$lib/ws/connection';
import { setRemoteSessionConnection } from '$lib/ws/dispatch-rules';
import { m } from '$lib/paraglide/messages.js';
import { eingabeFreigeben, eingabeMoeglich } from './sidecarInput';
import { isWindows } from '$lib/platform/runtime';
import { remoteP2P } from './p2p';
import { remoteVorrang } from './vorrang';
import { fremdeSitzungBeenden, herkunftsVerbindung, sendenAuf } from './draht';
import { KEINE_ANTWORT, remoteErrorMessage } from './fehlertexte';
import { WachtSchalter, anfrageFrist, fehlerWacht, verbindungsWacht } from './wachten';

export type RemotePhase = 'idle' | 'requesting' | 'incoming' | 'active';
export type RemoteRole = 'controller' | 'host';

/**
 * Wie lange eine unbeantwortete Anfrage stehen bleibt — auf BEIDEN Seiten.
 *
 * Der Gateway räumt sie nach 30 s ab
 * (`remote_registry.py::REMOTE_PENDING_TIMEOUT_S`), meldet das aber nur dem
 * Steuernden (`remote_ended`, reason 'timeout') und dem Host gar nicht. Diese
 * Frist liegt bewusst darüber und ist das Netz für beides: für den Steuernden,
 * falls die Meldung ausbleibt, und für den Host, dessen Consent-Dialog sonst
 * nach dem Verfall offen stehen bliebe.
 */
const ANFRAGE_FRIST_MS = 40_000;

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
   * Immer über [`#setConn`] setzen — die Empfangsseite hängt daran.
   */
  #conn: GatewayConnection | null = null;

  /**
   * Ziele von Anfragen, die abgebrochen wurden, BEVOR ihre Kennung ankam.
   *
   * **Warum es das braucht.** Zwischen `remote_request` und dem `remote_pending`
   * mit der Kennung liegt ein Serverumlauf. Wer in diesem Fenster abbricht und
   * sofort erneut anfragt, bekommt die verspätete Kennung der ERSTEN Anfrage —
   * und `_pending` erkannte die passende Anfrage nur an Ziel und Zustand, hatte
   * also keine Möglichkeit, sie von der zweiten zu unterscheiden.
   *
   * Die Folge war schlimmer als ein hängender Zustand: die alte Kennung wurde
   * der neuen Anfrage untergeschoben, und die danach eintreffende ECHTE Kennung
   * galt als fremd — `fremdeSitzungBeenden` beendete damit die gerade erst
   * entstandene, legitime Sitzung. Der Steuernde lief in „keine Antwort", der
   * Host blieb in „wird ferngesteuert" stehen.
   *
   * Eine Warteschlange und kein Zähler: so kann nur eine Kennung verworfen
   * werden, die WIRKLICH zum abgebrochenen Ziel gehört — eine Anfrage an
   * jemand anderen wird nicht mitverschluckt. Die Reihenfolge stimmt, weil
   * beide Rahmen über dieselbe Verbindung laufen.
   */
  readonly #verworfeneAnfragen: { channelId: string; hostUserId: string }[] = [];

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
    // ERST senden, DANN den Zustand setzen. `sendRemoteRequest` liefert bei
    // geschlossener WebSocket still `false`; ein vorher gesetztes 'requesting'
    // bliebe für immer stehen (die auflösende Antwort kann nicht kommen, die
    // Anfrage ging nie hinaus) — und weil oben jeder andere Zustand früh
    // zurückspringt, wäre danach JEDER weitere Klick wirkungslos. Genau so am
    // 2026-08-12 im Zwei-Geräte-Test aufgelaufen: geklickt, während die
    // Verbindung nach einem Gateway-Neustart noch neu aufgebaut wurde.
    if (!conn.sendRemoteRequest(channelId, hostUserId)) {
      this.error = m.remote_error_offline();
      return;
    }
    this.#setConn(conn);
    this.role = 'controller';
    this.peerUserId = hostUserId;
    this.channelId = channelId;
    this.targetSlot = slot;
    this.sessionId = null; // vergibt der Server, kommt gleich mit remote_pending
    this.phase = 'requesting';
    this.#watchErrors(); // Host offline / belegt → op:'error' abfangen
    this.#watchFrist(); // unbeantwortete Anfrage nicht ewig stehen lassen
  }

  /**
   * Der Gateway hat die Sitzung angelegt und meldet ihre Kennung — an den
   * Steuernden, bevor überhaupt ein Host-Tab die Anfrage sieht (Drahtvertrag
   * `remote_pending`). Erst ab hier hat die Anfrage einen Namen, unter dem sie
   * abgebrochen und jede Antwort geprüft werden kann.
   *
   * Alles, was nicht auf die eine offene Anfrage passt (falscher Host, falscher
   * Kanal, oder wir führen längst eine andere Kennung), wird nicht ignoriert,
   * sondern serverseitig BEENDET — Begründung bei `fremdeSitzungBeenden`. Das
   * deckt auch den Abbruch innerhalb des ersten Umlaufs ab: dort gibt es noch
   * keine Kennung, und dieser Frame bringt sie nach.
   */
  _pending(sessionId: string, channelId: string, hostUserId: string): void {
    // Zuerst: gehört diese Kennung zu einer Anfrage, die wir längst abgebrochen
    // haben? Dann beenden und NICHT übernehmen (s. `#verworfeneAnfragen`).
    const i = this.#verworfeneAnfragen.findIndex(
      (v) => v.channelId === channelId && v.hostUserId === hostUserId,
    );
    if (i >= 0) {
      this.#verworfeneAnfragen.splice(i, 1);
      fremdeSitzungBeenden(sessionId);
      return;
    }
    const passend =
      this.phase === 'requesting' &&
      this.role === 'controller' &&
      this.sessionId === null &&
      this.peerUserId === hostUserId &&
      this.channelId === channelId;
    if (!passend) {
      fremdeSitzungBeenden(sessionId);
      return;
    }
    this.sessionId = sessionId;
  }

  /**
   * Anfrage abbrechen, während noch auf die Freigabe gewartet wird.
   *
   * Muss den Server erreichen. Nur lokal zurückzuspringen sah bloß nach Abbruch
   * aus: die Sitzung blieb wartend, der Zustimmungsdialog des Hosts stand
   * weiter offen, und seine Zustimmung landete danach in einer Anfrage, die
   * längst jemand anderem galt.
   */
  cancel(): void {
    if (this.phase !== 'requesting') return;
    const id = this.sessionId;
    // Ergebnis ungeprüft wie in `deny()`: abgebrochen ist abgebrochen. Ist die
    // Kennung noch nicht da (Abbruch innerhalb des einen Umlaufs bis
    // `remote_pending`), räumt `_pending` das gleich nach.
    if (id) this.#senden((c) => c.sendRemoteEnd(id));
    else if (this.channelId && this.peerUserId) {
      // Kennung noch unterwegs: Ziel merken, damit `_pending` sie gleich
      // verwirft statt sie der nächsten Anfrage unterzuschieben.
      this.#verworfeneAnfragen.push({
        channelId: this.channelId,
        hostUserId: this.peerUserId,
      });
    }
    this.#reset();
  }

  /**
   * Eingabe-Frames auf der Verbindung DIESER Sitzung absetzen — über den Store
   * statt über `gateway`, denn nur hier ist bekannt, auf welcher Verbindung die
   * Sitzung läuft (s. `#conn`). `false` heißt „nicht hinausgegangen", kein Grund
   * zu beenden; ein echter Abriss ist Sache der Verbindungswacht. */
  sendInput(sessionId: string, slot: number, frames: string[]): boolean {
    if (this.phase !== 'active' || this.role !== 'controller') return false;
    if (!this.sessionId || sessionId !== this.sessionId) return false;
    // Erst der direkte Kanal (`p2p.ts`) — er sagt, ob er getragen hat oder was
    // dem Serverweg noch vorangehen muss (frisches Hello nach Kanal-Ausfall).
    const weg = remoteP2P.senden(sessionId, slot, frames);
    if (weg === 'p2p') return true;
    if (weg === 'ws_mit_hello') {
      // Hello plus letzte Zeigerlage — ein nacktes Hello löscht beim Host
      // die Lage, und ohne Lage feuert kein Knopf (s. `helloBuendel`).
      // Erst ein ERFOLGREICHER Send vollzieht den Rückweg (`wsHelloGesendet`);
      // scheitert er, verlangt die nächste Nachricht das Hello erneut.
      if (this.#senden((c) => c.sendRemoteInput(sessionId, slot, remoteP2P.helloBuendel()))) {
        remoteP2P.wsHelloGesendet();
        // Das Hello gibt beim Host ALLES frei (Wire-Spec, „neuer
        // Eingabestrom"). Was der Nutzer noch physisch hält, muss deshalb
        // erneut behauptet werden — sonst ist seine Taste nach einem
        // Kanalausfall tot, obwohl der Finger daraufliegt. Dieselbe Lücke wie
        // nach einem Vorrang des Hosts, und derselbe Baustein
        // (`buchfuehrung.ts::nachziehBuendel`).
        for (const buendel of remoteP2P.nachziehBuendel()) {
          this.#senden((c) => c.sendRemoteInput(sessionId, slot, buendel));
        }
      }
    }
    return this.#senden((c) => c.sendRemoteInput(sessionId, slot, frames));
  }

  // ── Host-Seite ────────────────────────────────────────────────────────────
  accept(): void {
    if (this.phase !== 'incoming' || !this.sessionId) return;
    const id = this.sessionId;
    // ERST senden, DANN den Zustand ändern — dieselbe Regel wie beim Steuernden
    // in `request()`. Ging die Zustimmung nicht hinaus (Reconnect-Blip), bliebe
    // die Phase auf 'incoming' stehen; daran hängt der Consent-Dialog mit nach
    // dem Klick stillgelegten Knöpfen, aus dem der Host dann nur noch durch
    // Neuladen herauskäme. Fehlgeschlagen heißt ohnehin „Anfrage tot": ist der
    // Socket zu, hat der Gateway sie abgeräumt (`cleanup_remote_on_disconnect`).
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
    // WURF des Senders das Aufräumen nicht überspringt; dafür fängt `#senden`
    // alles ab.
    this.#senden((c) => c.sendRemoteRespond(id, false));
    this.#reset();
  }

  // ── Beide ─────────────────────────────────────────────────────────────────
  end(): void {
    const id = this.sessionId;
    if (id) this.#senden((c) => c.sendRemoteEnd(id)); // s. `deny()`: Ende bleibt Ende
    this.#reset();
  }

  /**
   * Abmelden: alles fallen lassen, ohne dem Gegenüber etwas zu schicken.
   *
   * **Warum das gebraucht wird.** Dieser Store ist ein Modul-Singleton und
   * überlebt einen Kontowechsel, denn die Anmeldung läuft ohne Neuladen der
   * Seite. `signOut()` räumt zwei Dutzend Speicher auf — dieser fehlte, und
   * eine noch offene Anfrage blieb stehen: der NÄCHSTE Nutzer am selben Tab
   * bekam bis zu 40 Sekunden lang den Zustimmungs-Dialog eines Fremden
   * vorgesetzt, samt „Erlauben"-Knopf. Der Klick liefe zwar ins Leere (die
   * Verbindung ist mit `gatewayPool.closeAll()` weg), aber angezeigt wird ein
   * Vorgang, der ihn nichts angeht — und bei einer Anzeige über Kontrolle am
   * eigenen Rechner ist das der falsche Ort für „läuft schon ins Leere".
   *
   * Der Verbindungswächter fängt es NICHT ab: er läuft erst ab `active`
   * (s. `#watchVerbindung`), eine wartende Anfrage kennt ihn nicht.
   *
   * Bewusst ohne Nachricht an den Server: die Verbindung ist beim Abmelden
   * ohnehin geschlossen, und der Gateway räumt seine Seite über den
   * Socket-Abbau selbst auf (`cleanup_remote_on_disconnect`).
   */
  abmelden(): void {
    this.#verworfeneAnfragen.length = 0;
    this.#reset();
    this.error = null; // beim Kontowechsel auch keine Fehlermeldung erben
  }

  // ── Inbound (vom Handler-Modul `handlers/remote.ts`) ──────────────────────
  _incomingRequest(sessionId: string, channelId: string, fromUserId: string): void {
    if (this.phase !== 'idle') return; // schon beschäftigt — Server-Gate (4054) deckt das ab
    // Kann dieser Rechner überhaupt ferngesteuert werden? Ohne Brücke
    // (Browser, Android) oder außerhalb von Windows (der einzige Sidecar mit
    // Injektion) wird OHNE Dialog abgelehnt (Bughunt R2): der reguläre Weg
    // zeigt den Anfrage-Knopf nur an fernsteuerbaren Streams, aber der
    // Gateway prüft die Fähigkeit bewusst nicht — eine selbstgebaute Anfrage
    // brächte sonst den vollen Zustimmungs-Dialog auf einen Rechner, dessen
    // zugestimmte Sitzung beim ersten Frame wortlos stürbe. Ein Dialog, dem
    // man nur zustimmen kann, damit nichts passiert, ist der falsche Dialog.
    if (!eingabeMoeglich() || !isWindows()) {
      sendenAuf(herkunftsVerbindung(), (c) => c.sendRemoteRespond(sessionId, false));
      return;
    }
    this.error = null;
    // Die Verbindung, über die die Anfrage hereinkam, festhalten: die Antwort
    // gehört auf dieselbe (Begründung in `draht.ts`).
    this.#setConn(herkunftsVerbindung());
    this.role = 'host';
    this.sessionId = sessionId;
    this.channelId = channelId;
    this.peerUserId = fromUserId;
    this.targetSlot = 0; // Host-Seite: der Slot steht in jeder einzelnen Nachricht.
    this.phase = 'incoming';
    // Auch der Host bekommt Frist und Fehler-Wacht: der Gateway räumt eine
    // unbeantwortete Anfrage nach 30 s ab, sagt das aber NUR dem Steuernden —
    // sonst stünde der Consent-Dialog danach offen, und ein später Klick auf
    // „Erlauben" holte sich wortlos ein 4053 ab.
    this.#watchFrist('Die Anfrage ist abgelaufen.');
    this.#watchErrors();
  }

  _response(sessionId: string, accepted: boolean): void {
    // Eine Response ist nur zu erwarten, solange wir wirklich darauf warten:
    // Controller in 'requesting', Host in 'incoming'. Ein Duplikat/verspätetes
    // Echo im 'active'-Zustand würde sonst eine tote Session wiederbeleben.
    if (this.phase !== 'requesting' && this.phase !== 'incoming') return;
    if (this.role === null) return;
    // Ohne bekannte Kennung wird NICHTS angenommen — beide Seiten haben sie hier
    // (Host aus `remote_request`, Steuernder aus `remote_pending`). Ein früheres
    // `sessionId === null` ließ jede Antwort durch, auch die zu einer
    // abgebrochenen Anfrage an einen ANDEREN Host (Erfassung am falschen Gerät).
    if (this.sessionId === null || sessionId !== this.sessionId) return;
    this.#fehler.aus();
    this.#frist.aus();
    if (!accepted) {
      this.error = 'Anfrage abgelehnt.';
      this.#reset();
      return;
    }
    this.phase = 'active';
    this.#watchVerbindung();
    // Den direkten Eingabekanal daneben aufbauen — auf der Verbindung DIESER
    // Sitzung, wie alles andere. Bis er steht, trägt der Serverweg; scheitert
    // er (NAT), bleibt es wortlos dabei. Die Rolle steht fest: ohne sie ist
    // oben schon zurückgesprungen.
    remoteP2P.start(this.role, sessionId, (kind, data) =>
      this.#senden((c) => c.sendRemoteSignal(sessionId, kind, data)),
    );
    // Vorrang des Hosts (`vorrang.ts`): der Host meldet, wenn er selbst an
    // Maus und Tastatur greift, der Steuernde zeigt es an und zieht danach
    // sein Gehaltenes nach. Läuft neben dem Eingabeweg und über denselben
    // Signalweg wie dessen Verhandlung.
    remoteVorrang.start(
      this.role,
      (kind, data) => this.#senden((c) => c.sendRemoteSignal(sessionId, kind, data)),
      (frames) => void this.sendInput(sessionId, this.targetSlot, frames),
    );
  }

  _ended(sessionId: string, reason: string): void {
    // Auch hier ist die Kennung die einzige Zuordnung: ein `remote_ended`
    // (z.B. der Zeitablauf) einer abgebrochenen Anfrage darf die frische
    // Anfrage an jemand anderen nicht abräumen. Seit `remote_pending` kennt der
    // Steuernde sie auch im Wartezustand — deshalb kein `null`-Sonderweg mehr.
    if (this.sessionId === null || sessionId !== this.sessionId) return;
    if (this.phase === 'requesting' && reason === 'timeout') this.error = KEINE_ANTWORT;
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

  /** Senden über die Verbindung DIESER Sitzung (`draht.ts::sendenAuf`). */
  #senden(fn: (c: GatewayConnection) => boolean): boolean {
    return sendenAuf(this.#conn, fn);
  }

  /** `#conn` immer hierüber setzen: die Dispatch-Regel für nicht-aktive
   *  Verbindungen (`ws/dispatch-rules.ts`) muss dieselbe Verbindung kennen,
   *  sonst kommen die Frames der Sitzung nach einem Community-Wechsel nicht
   *  mehr an. */
  #setConn(conn: GatewayConnection | null): void {
    this.#conn = conn;
    setRemoteSessionConnection(conn);
  }

  #reset(): void {
    this.#fehler.aus();
    this.#verbindung.aus();
    this.#frist.aus();
    // Der direkte Kanal endet mit der Sitzung — #reset ist der EINZIGE Ausgang
    // (s. den Kommentar unten), also auch seiner. Der Vorrang-Melder ebenso:
    // er hängt am Sidecar-Ereignisstrom und hätte sonst einen Zuhörer über die
    // Sitzung hinaus.
    // **Reihenfolge trägt:** der Vorrang gibt eine übernommene Anzeige zurück
    // und braucht dafür den Eingabeweg-Text, den `remoteP2P.stop()` löscht.
    remoteVorrang.stop();
    remoteP2P.stop();
    // „Alles loslassen beim Ende" (Wire-Spec) — hier, weil #reset der EINZIGE
    // Ausgang aus jeder Sitzung ist: Beenden, Ablehnung, Gegenüber weg,
    // Verbindungsverlust, Fehler. Ohne diesen Ruf liefe nach einem Abbruch die
    // W-Taste im Spiel für immer weiter. Idempotent, deshalb ungefiltert nach
    // Rolle: der Host ist der einzige, der je eine Eingabe-Sitzung hatte.
    void eingabeFreigeben();
    this.phase = 'idle';
    this.role = null;
    this.sessionId = null;
    this.peerUserId = null;
    this.channelId = null;
    this.targetSlot = 0;
    this.#setConn(null);
    // `error` bleibt bewusst stehen: er wird oft im selben Zug gesetzt, in dem
    // hier aufgeräumt wird (Ablehnung, Zeitablauf), und `RemoteErrorToast` holt
    // ihn erst im nächsten Effect ab. Gelöscht beim Anzeigen und beim Start der
    // nächsten Anfrage.
  }

  /** Verbindungsverlust beendet die Sitzung (Begründung in `wachten.ts`).
   *  Gemessen wird die Verbindung DIESER Sitzung: sonst beendete ein
   *  Server-Wechsel die Fernsteuerung — und umgekehrt liefe sie weiter, obwohl
   *  ihr eigener Träger längst weg wäre. */
  #watchVerbindung(): void {
    this.#verbindung.an(() => verbindungsWacht(this.#conn, () => this.#reset()));
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

export const remoteSession = new RemoteSessionStore();
