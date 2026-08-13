/**
 * Fernsteuerung — P2P-Eingabeweg über einen WebRTC-DataChannel (Stufe 1 des
 * Plans `docs/plans/2026-08-13-fernsteuerung-p2p-eingabeweg.md`).
 *
 * Der Serverweg trägt die Eingabe über den Gateway (~116 ms Netz im
 * geschlossenen Kreis, gemessen 2026-08-12); dieser Kanal spannt sich direkt
 * zwischen den beiden RENDERERN auf und lässt beide Server-Hops aus. Es
 * wechselt NUR der Träger in der Mitte: Erfassung (pulse-player), Bündelung
 * (Electron) und Injektion (win-hq-sidecar) bleiben wortgleich — die Frames
 * sind dieselben Base64-Stücke, die Nachricht dieselbe Hülle
 * `{session_id, slot, frames}`.
 *
 * **Signaling** läuft über den `remote_signal`-Weiterleiter des Gateways
 * (peer-gebunden an die aktive Sitzung, 8 KiB, 60/s — `ws_remote_handlers.py`).
 * Damit reitet der DTLS-Schlüsseltausch auf derselben authentifizierten
 * Verbindung wie der Consent: wer den Kanal beantworten kann, ist genau das
 * per Zustimmung bestätigte Gegenüber.
 *
 * **Transportwechsel nur in Ruhe.** WS und DataChannel sind je für sich
 * geordnet, aber nicht gegeneinander. Wechselte der Sender mitten in einem
 * Tastendruck, könnte ein via WS abgeschicktes Drücken NACH dem
 * DataChannel-Hello ankommen (das beim Host alles freigibt) — die Taste bliebe
 * am fremden Rechner unten, bis die Sitzung endet. Deshalb wird erst
 * gewechselt, wenn NICHTS gedrückt ist: Drücken und Loslassen paaren sich dann
 * immer auf demselben, in sich geordneten Träger, und was danach noch
 * verspätet eintrifft, sind Bewegungen (folgenlos) oder Loslassen ohne Drücken
 * (beim Host ein No-op). Jeder Wechsel beginnt mit einem frischen Hello —
 * „neuer Eingabestrom", die Wire-Spec deckt das ausdrücklich.
 *
 * **Fällt der Kanal aus, geht es wortlos über den Serverweg weiter** — die
 * Fernsteuerung war vor diesem Modul vollständig funktionsfähig und bleibt es
 * ohne ihn. Kein TURN in Stufe 1: hinter symmetrischem NAT kommt schlicht kein
 * Kanal zustande und der Serverweg trägt weiter (der TURN-Cred-Endpunkt liegt
 * auf `feat/remote-control-windows`, s. Plan).
 */

export type SignalKind = 'offer' | 'answer' | 'ice';
type SignalSender = (kind: SignalKind, data: unknown) => boolean;
type FrameSink = (evt: { session_id: string; slot: number; frames: string[] }) => void;

/** Wie der Sender einer Nachricht verfahren soll (`RemoteSessionStore.sendInput`). */
export type Transportwahl = 'p2p' | 'ws' | 'ws_mit_hello';

/**
 * Der Handschlag-Frame des Wire-Protokolls v2: Opcode 0x00 + Fassung 2
 * (`rahmen.rs::PROTOKOLL_VERSION`). Normal erzeugt ihn der pulse-player beim
 * Einschalten der Erfassung; beim TRANSPORTWECHSEL muss er hier entstehen,
 * denn der Player weiß nichts vom Träger. Als eigene Nachricht gesendet, nie
 * in eine bestehende gemischt — eine volle 32-Frame-Nachricht plus Hello wäre
 * 33 und damit fail-closed.
 */
export const HELLO_FRAME_B64 = btoa(String.fromCharCode(0x00, 0x02));

/** Dieselbe STUN-Adresse wie der WHEP-Zuschauerweg (`stream/whep.ts`). */
const STUN = 'stun:stun.l.google.com:19302';

/** Obergrenzen je hereinkommender Kanal-Nachricht — Spiegel der Gateway-
 *  Grenzen (`ws_remote_input.py`). Überschreitung wird STILL verworfen statt
 *  an den Sidecar gereicht: dort wäre >32 ein Protokollfehler und legte die
 *  ganze Sitzung still, hier ist es nur eine kaputte Nachricht. */
const MAX_FRAMES = 32;
const MAX_NACHRICHT_ZEICHEN = 16 * 1024;

class RemoteP2P {
  #pc: RTCPeerConnection | null = null;
  #dc: RTCDataChannel | null = null;
  #sessionId: string | null = null;
  #role: 'controller' | 'host' | null = null;
  #sendSignal: SignalSender | null = null;
  #frameSink: FrameSink | null = null;
  /** ICE-Kandidaten, die vor der Gegenbeschreibung eintreffen — gepuffert
   *  statt verworfen (genau der Fehler, den der P2P-Zweig schon einmal
   *  gefunden hat: Trickle-Kandidaten überholen das Angebot). */
  #eisPuffer: RTCIceCandidateInit[] = [];
  /** Läuft der Versand gerade über den Kanal? Erst nach dem Ruhe-Wechsel. */
  #ueberKanal = false;
  /** Nach einem Kanal-Ausfall: die nächste WS-Nachricht braucht ein Hello. */
  #wsHelloFaellig = false;
  /** Was laut den GESENDETEN Frames gerade unten ist ('k<scan>' / 'b<btn>').
   *  Grundlage der Ruhe-Bedingung für den Transportwechsel. */
  readonly #unten = new Set<string>();

  /** Wohin hereinkommende Frames gehen — setzt `handlers/remote.ts` beim
   *  Registrieren (derselbe geprüfte Pfad wie der Serverweg). Als Injektion
   *  statt Import, sonst entstünde ein Kreis session → p2p → handlers →
   *  session. */
  setFrameSink(sink: FrameSink): void {
    this.#frameSink = sink;
  }

  /** Mit dem Übergang der Sitzung nach 'active' rufen. Der Steuernde macht
   *  das Angebot; der Host wartet auf dessen `offer`. */
  start(role: 'controller' | 'host', sessionId: string, sendSignal: SignalSender): void {
    this.stop();
    this.#role = role;
    this.#sessionId = sessionId;
    this.#sendSignal = sendSignal;
    if (role === 'controller') void this.#anbieten();
  }

  /** Sitzungsende — der eine Ausgang, wie `RemoteSessionStore.#reset`. */
  stop(): void {
    this.#dc?.close();
    this.#pc?.close();
    this.#dc = null;
    this.#pc = null;
    this.#sessionId = null;
    this.#role = null;
    this.#sendSignal = null;
    this.#eisPuffer.length = 0;
    this.#ueberKanal = false;
    this.#wsHelloFaellig = false;
    this.#unten.clear();
  }

  /**
   * Eine ausgehende Nachricht des Steuernden einordnen — und, wenn der Kanal
   * trägt, gleich senden. Die Rückgabe sagt dem Aufrufer, was noch zu tun ist:
   * `'p2p'` = erledigt, `'ws'` = über den Serverweg, `'ws_mit_hello'` = über
   * den Serverweg, aber mit vorangestelltem Hello (der Kanal ist gerade
   * gestorben, der Host braucht einen frischen Eingabestrom).
   */
  senden(sessionId: string, slot: number, frames: string[]): Transportwahl {
    // Gedrückt-Buchführung IMMER, egal welcher Träger — sie entscheidet, wann
    // ein Wechsel gefahrlos ist.
    for (const frame of frames) this.#buchen(frame);

    const kanalOffen =
      this.#dc?.readyState === 'open' && this.#sessionId === sessionId;
    if (!kanalOffen) {
      if (this.#ueberKanal) {
        // Der Kanal ist unter uns weggebrochen: zurück auf den Serverweg,
        // einmal mit frischem Hello (unbekannt, was noch ankam).
        this.#ueberKanal = false;
        this.#wsHelloFaellig = true;
        console.info('[remote-p2p] Kanal weg — zurück auf den Serverweg');
      }
      if (this.#wsHelloFaellig) {
        this.#wsHelloFaellig = false;
        return 'ws_mit_hello';
      }
      return 'ws';
    }

    if (!this.#ueberKanal) {
      // Ruhe-Bedingung: erst wechseln, wenn nichts unten ist (s. Kopf).
      if (this.#unten.size > 0) return 'ws';
      this.#ueberKanal = true;
      this.#kanalSenden(sessionId, slot, [HELLO_FRAME_B64]);
      console.info('[remote-p2p] Eingabe läuft jetzt direkt (DataChannel)');
    }
    this.#kanalSenden(sessionId, slot, frames);
    return 'p2p';
  }

  /** Hereinkommendes `remote_signal` der eigenen Sitzung (Zuordnung prüft der
   *  Handler). */
  signal(kind: SignalKind, data: unknown): void {
    if (kind === 'offer' && this.#role === 'host') void this.#antworten(data);
    else if (kind === 'answer' && this.#role === 'controller') void this.#annehmen(data);
    else if (kind === 'ice') void this.#kandidat(data);
  }

  // ── Verbindungsaufbau ─────────────────────────────────────────────────────

  #neuerPeer(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN }] });
    pc.onicecandidate = (e) => {
      if (e.candidate) this.#sendSignal?.('ice', { candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      // 'failed' räumt auf; der Versand fällt über `senden()` von selbst auf
      // den Serverweg zurück. Kein Neuversuch innerhalb der Sitzung — der
      // Serverweg trägt, und ein Kanal, der einmal scheiterte, scheitert an
      // derselben Netzlage meist wieder.
      if (pc.connectionState === 'failed') {
        console.info('[remote-p2p] Verbindung fehlgeschlagen — Serverweg bleibt');
        this.#pc = null;
        this.#dc = null;
      }
    };
    this.#pc = pc;
    return pc;
  }

  async #anbieten(): Promise<void> {
    try {
      const pc = this.#neuerPeer();
      const dc = pc.createDataChannel('pulse-input');
      this.#kanalVerdrahten(dc);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.#sendSignal?.('offer', { type: offer.type, sdp: offer.sdp });
    } catch (e) {
      console.warn('[remote-p2p] Angebot scheiterte — Serverweg bleibt:', e);
    }
  }

  async #antworten(data: unknown): Promise<void> {
    try {
      const beschreibung = data as RTCSessionDescriptionInit;
      const pc = this.#neuerPeer();
      pc.ondatachannel = (e) => this.#kanalVerdrahten(e.channel);
      await pc.setRemoteDescription(beschreibung);
      await this.#eisNachziehen();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.#sendSignal?.('answer', { type: answer.type, sdp: answer.sdp });
    } catch (e) {
      console.warn('[remote-p2p] Antwort scheiterte — Serverweg bleibt:', e);
    }
  }

  async #annehmen(data: unknown): Promise<void> {
    try {
      await this.#pc?.setRemoteDescription(data as RTCSessionDescriptionInit);
      await this.#eisNachziehen();
    } catch (e) {
      console.warn('[remote-p2p] Gegenbeschreibung scheiterte — Serverweg bleibt:', e);
    }
  }

  async #kandidat(data: unknown): Promise<void> {
    const kandidat = (data as { candidate?: RTCIceCandidateInit }).candidate;
    if (!kandidat) return;
    if (!this.#pc?.remoteDescription) {
      this.#eisPuffer.push(kandidat);
      return;
    }
    try {
      await this.#pc.addIceCandidate(kandidat);
    } catch (e) {
      console.warn('[remote-p2p] ICE-Kandidat abgelehnt:', e);
    }
  }

  async #eisNachziehen(): Promise<void> {
    const wartend = this.#eisPuffer.splice(0);
    for (const kandidat of wartend) {
      try {
        await this.#pc?.addIceCandidate(kandidat);
      } catch (e) {
        console.warn('[remote-p2p] gepufferter ICE-Kandidat abgelehnt:', e);
      }
    }
  }

  // ── Kanal ─────────────────────────────────────────────────────────────────

  #kanalVerdrahten(dc: RTCDataChannel): void {
    this.#dc = dc;
    // Nur der HOST nimmt Frames an; beim Steuernden bleibt `onmessage` leer —
    // der Kanal ist eine Einbahnstraße, alles andere wäre eine Rückleitung,
    // die niemand bestellt hat.
    if (this.#role === 'host') dc.onmessage = (e) => this.#empfangen(e.data);
  }

  #kanalSenden(sessionId: string, slot: number, frames: string[]): void {
    try {
      this.#dc?.send(JSON.stringify({ session_id: sessionId, slot, frames }));
    } catch {
      // Ein Wurf hier heißt „Kanal gerade zugegangen" — der nächste
      // `senden()`-Ruf sieht das am readyState und fällt mit Hello zurück.
      // Die aktuelle Nachricht ist verloren; das ist derselbe Verlustfall wie
      // ein WS-Send auf toter Verbindung und heilt über das Hello.
    }
  }

  #empfangen(roh: unknown): void {
    if (typeof roh !== 'string' || roh.length > MAX_NACHRICHT_ZEICHEN) return;
    let msg: { session_id?: unknown; slot?: unknown; frames?: unknown };
    try {
      msg = JSON.parse(roh);
    } catch {
      return;
    }
    // Still verwerfen statt fail-closed: die Grenzen spiegeln den Gateway
    // (eine Grenzüberschreitung kostet eine Nachricht, nicht die Sitzung).
    // Die eigentliche Autorisierung macht der eingehängte Pfad — derselbe
    // `eingabe()`-Wächter, den auch der Serverweg passiert.
    if (typeof msg.session_id !== 'string' || msg.session_id !== this.#sessionId) return;
    if (!Array.isArray(msg.frames) || msg.frames.length === 0) return;
    if (msg.frames.length > MAX_FRAMES) return;
    if (!msg.frames.every((f) => typeof f === 'string')) return;
    const slot = typeof msg.slot === 'number' && Number.isInteger(msg.slot) ? msg.slot : 0;
    this.#frameSink?.({
      session_id: msg.session_id,
      slot,
      frames: msg.frames as string[],
    });
  }

  // ── Gedrückt-Buchführung ──────────────────────────────────────────────────

  /** Frame-Opcode lesen und die Gedrückt-Menge nachführen. Layout aus
   *  `rahmen.rs`: 0x03 = Maustaste [op, btn, down], 0x05 = Taste
   *  [op, scan_lo, scan_hi, down]. Unlesbares wird ignoriert — die Prüfung
   *  der Frames selbst ist Sache des Sidecars (fail-closed). */
  #buchen(frameB64: string): void {
    let bytes: string;
    try {
      bytes = atob(frameB64);
    } catch {
      return;
    }
    const op = bytes.charCodeAt(0);
    if (op === 0x03 && bytes.length === 3) {
      const id = `b${bytes.charCodeAt(1)}`;
      if (bytes.charCodeAt(2) !== 0) this.#unten.add(id);
      else this.#unten.delete(id);
    } else if (op === 0x05 && bytes.length === 4) {
      const id = `k${bytes.charCodeAt(1) | (bytes.charCodeAt(2) << 8)}`;
      if (bytes.charCodeAt(3) !== 0) this.#unten.add(id);
      else this.#unten.delete(id);
    } else if (op === 0x00) {
      // Ein Hello aus dem Player (Erfassung neu eingeschaltet) leert auch
      // unsere Buchführung — der Host gibt dabei ohnehin alles frei.
      this.#unten.clear();
    }
  }
}

export const remoteP2P = new RemoteP2P();
