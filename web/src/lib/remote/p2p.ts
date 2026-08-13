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

import type { RemoteSignalKind } from '$lib/ws/handlers/types';
import { Gedruecktbuch, MAX_FRAMES } from './buchfuehrung';

type SignalSender = (kind: RemoteSignalKind, data: unknown) => boolean;
type FrameSink = (evt: { session_id: string; slot: number; frames: string[] }) => void;

/** Wie der Sender einer Nachricht verfahren soll (`RemoteSessionStore.sendInput`). */
export type Transportwahl = 'p2p' | 'ws' | 'ws_mit_hello';

/** Dieselbe STUN-Adresse wie der WHEP-Zuschauerweg (`stream/whep.ts`). */
const STUN = 'stun:stun.l.google.com:19302';

/** Obergrenzen je hereinkommender Kanal-Nachricht — Spiegel der Gateway-
 *  Grenzen (`ws_remote_input.py`). Überschreitung wird STILL verworfen statt
 *  an den Sidecar gereicht: dort wäre >32 ein Protokollfehler und legte die
 *  ganze Sitzung still, hier ist es nur eine kaputte Nachricht. Die Frame-Zahl
 *  teilen sich beide Dateien (`buchfuehrung.ts`). */
const MAX_NACHRICHT_ZEICHEN = 16 * 1024;
/** Größte dekodierte Nutzlast JE NACHRICHT (Gateway:
 *  `MAX_INPUT_DECODED_BYTES` — dort ist 1024 die Summe, nicht der
 *  Einzel-Frame; Bughunt R2). */
const MAX_NACHRICHT_BYTES = 1024;
/** Höchster zulässiger Slot — Spiegel von `SLOT_MAX` im Gateway
 *  (`dcc_shared/streaming.py`: `MAX_SLOTS - 1`, Client-Kopie
 *  `stream/state.svelte.ts::MAX_STREAM_SLOTS`). */
const SLOT_MAX = 98;

/** Strenges Base64, wie es Gateway (`b64decode(validate=True)`) und Sidecar
 *  verlangen — `atob` allein ist „forgiving" und schluckt fehlende Füllung
 *  und Leerraum, die weiter hinten fail-closed wären (Bughunt R2). Verlangt
 *  mindestens ein Zeichen: der Leer-Frame ist beim Sidecar ein
 *  Protokollfehler. */
const BASE64_STRENG = /^[A-Za-z0-9+/]+={0,2}$/;

/** Dekodierte Länge des Frames, oder `null`, wenn er die strenge
 *  Base64-Form verfehlt. */
function frameBytes(frameB64: string): number | null {
  if (frameB64.length % 4 !== 0 || !BASE64_STRENG.test(frameB64)) return null;
  try {
    return atob(frameB64).length;
  } catch {
    return null;
  }
}

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
  /** Was laut den GESENDETEN Frames gerade unten ist, samt letzter Zeigerlage
   *  (`buchfuehrung.ts`). Grundlage der Ruhe-Bedingung für den
   *  Transportwechsel — und des Nachziehens nach einem Vorrang des Hosts. */
  readonly #buch = new Gedruecktbuch();
  /** Anzeige des Eingabewegs (s. [`setStatusSink`]). Die Texte entstehen
   *  HIER, an der Zustandsmaschine — der Player zeigt sie nur. */
  #statusSink: ((transport: string) => void) | null = null;
  #letzterStatus = '';
  /** Text, der die Anzeige vorübergehend übernommen hat (`vorrang.ts`) —
   *  `null` = der Eingabeweg zeigt sich selbst. Der Eingabeweg wird darunter
   *  weitergeführt, damit nach dem Vorrang der aktuelle Stand erscheint und
   *  nicht der von vorhin. */
  #uebernommen: string | null = null;

  /** Wohin hereinkommende Frames gehen — setzt `handlers/remote.ts` beim
   *  Registrieren (derselbe geprüfte Pfad wie der Serverweg). Als Injektion
   *  statt Import, sonst entstünde ein Kreis session → p2p → handlers →
   *  session. */
  setFrameSink(sink: FrameSink): void {
    this.#frameSink = sink;
  }

  /**
   * Wohin der Anzeigetext des Eingabewegs geht (Statistik-Feld im
   * Player-Fenster). Beim Setzen wird der AKTUELLE Stand sofort nachgereicht:
   * der Kanalaufbau beginnt mit der Zustimmung, das Player-Fenster meldet
   * sich oft erst danach — ohne Wiederholung verpasste die Anzeige jeden
   * Übergang, der vor ihrem Anschluss lag.
   */
  setStatusSink(sink: ((transport: string) => void) | null): void {
    this.#statusSink = sink;
    const text = this.#uebernommen ?? this.#letzterStatus;
    if (sink && text !== '') sink(text);
  }

  #status(transport: string): void {
    if (transport === this.#letzterStatus) return;
    this.#letzterStatus = transport;
    // Unter einer Übernahme wird weiter Buch geführt, aber nicht gezeigt: der
    // Vorrang des Hosts ist die dringendere Auskunft, und ein Wechsel des
    // Eingabewegs mitten darin überschriebe sie.
    if (this.#uebernommen === null) this.#statusSink?.(transport);
  }

  /** Mit dem Übergang der Sitzung nach 'active' rufen. Der Steuernde macht
   *  das Angebot; der Host wartet auf dessen `offer`. */
  start(role: 'controller' | 'host', sessionId: string, sendSignal: SignalSender): void {
    this.stop();
    this.#role = role;
    this.#sessionId = sessionId;
    this.#sendSignal = sendSignal;
    if (role === 'controller') {
      this.#status('Serverweg — Direktverbindung wird verhandelt');
      void this.#anbieten();
    }
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
    this.#buch.leeren();
    this.#letzterStatus = '';
    this.#uebernommen = null;
  }

  /**
   * Eine ausgehende Nachricht des Steuernden einordnen — und, wenn der Kanal
   * trägt, gleich senden. Die Rückgabe sagt dem Aufrufer, was noch zu tun ist:
   * `'p2p'` = erledigt, `'ws'` = über den Serverweg, `'ws_mit_hello'` = über
   * den Serverweg, aber mit vorangestelltem Hello (der Kanal ist gerade
   * gestorben, der Host braucht einen frischen Eingabestrom).
   */
  senden(sessionId: string, slot: number, frames: string[]): Transportwahl {
    // Ruhe wird gegen den Stand VOR dieser Nachricht gemessen (Bughunt
    // 2026-08-13): Die Nachricht mit dem LETZTEN Loslassen leert `#unten` —
    // erst danach geprüft, schaltete genau sie um, und ihr Loslassen fuhr
    // über den Kanal, während sein Drücken noch als WS-Nachricht unterwegs
    // war. Das DC-Hello gab beim Host alles frei, das verspätete WS-Drücken
    // kam danach an: Taste klemmt. Dasselbe Loch öffnete jedes Player-Hello
    // (leert die Buchführung ohne Hoch-Ereignisse). Vor der Nachricht ruhig
    // heißt dagegen: jedes Paar aus Drücken und Loslassen liegt vollständig
    // auf einem in sich geordneten Träger.
    const ruhigVorher = this.#buch.ruhig;
    // Gedrückt-Buchführung IMMER, egal welcher Träger.
    for (const frame of frames) this.#buch.buchen(frame);

    const kanalOffen =
      this.#dc?.readyState === 'open' && this.#sessionId === sessionId;
    if (!kanalOffen) {
      if (this.#ueberKanal) {
        // Der Kanal ist unter uns weggebrochen: zurück auf den Serverweg, und
        // zwar mit frischem Hello (unbekannt, was noch ankam). `#ueberKanal`
        // löscht erst [`wsHelloGesendet`] — ging das Hello nicht hinaus
        // (Reconnect-Blip, Bughunt R2), verlangt der nächste Ruf es erneut;
        // ohne das bliebe ein Down, dessen Up im sterbenden Kanal verschwand,
        // beim Host bis Sitzungsende unten.
        return 'ws_mit_hello';
      }
      return 'ws';
    }

    if (!this.#ueberKanal) {
      // Ruhe-Bedingung: erst wechseln, wenn VOR dieser Nachricht nichts
      // unten war (s. oben) — und nicht im Nachlauf eines Player-Hellos:
      // GENAU das Hello, das die Ruhe herstellt (es leert die Buchführung
      // ohne Hoch-Ereignisse — Erfassung neu eingeschaltet, Notbremse),
      // fliegt in diesem Moment noch als WS-Nachricht. Wechselte man sofort,
      // träfe es NACH dem Kanal-Hello ein und gäbe beim Host alles frei, was
      // seither über den Kanal gedrückt wurde (Bughunt R2). Eine
      // WS-Laufzeit plus Reserve warten kostet nichts — der Serverweg trägt
      // währenddessen.
      if (!ruhigVorher || this.#buch.helloFrisch) return 'ws';
      this.#ueberKanal = true;
      this.#kanalSenden(sessionId, slot, this.helloBuendel());
      console.info('[remote-p2p] Eingabe läuft jetzt direkt (DataChannel)');
      this.#status('Direktverbindung');
    }
    this.#kanalSenden(sessionId, slot, frames);
    return 'p2p';
  }

  /** Der Aufrufer hat das Rückfall-Hello ERFOLGREICH über den Serverweg
   *  abgesetzt — erst jetzt gilt der Rückweg als vollzogen. */
  wsHelloGesendet(): void {
    if (this.#ueberKanal) {
      this.#ueberKanal = false;
      console.info('[remote-p2p] Kanal weg — zurück auf den Serverweg');
      this.#status('Serverweg — Direktverbindung abgerissen');
    }
  }

  /** Was ein Transportwechsel dem Host als Erstes schickt (`buchfuehrung.ts`). */
  helloBuendel(): string[] {
    return this.#buch.helloBuendel();
  }

  /** Den gehaltenen Zustand nach einem Vorrang des Hosts erneut behaupten —
   *  in Nachrichten zu je höchstens 32 Frames (`buchfuehrung.ts`). */
  nachziehBuendel(): string[][] {
    return this.#buch.nachziehBuendel();
  }

  /**
   * Anzeigetext von außen setzen — für den Vorrang des Hosts (`vorrang.ts`),
   * der das Statistik-Feld für seine Dauer übernimmt.
   *
   * `null` heißt „zurück auf den Eingabeweg": den Text dafür kennt nur diese
   * Zustandsmaschine, und ihn beim Steuernden zwischenzulagern hieße, ihn an
   * zwei Stellen zu führen.
   */
  anzeigeUebernehmen(text: string | null): void {
    this.#uebernommen = text;
    this.#statusSink?.(text ?? this.#letzterStatus);
  }

  /** Hereinkommendes `remote_signal` der eigenen Sitzung (Zuordnung prüft der
   *  Handler). */
  signal(kind: RemoteSignalKind, data: unknown): void {
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
      //
      // WIRKLICH schließen, nicht nur die Verweise nullen (Bughunt
      // 2026-08-13): eine nur vergessene PeerConnection lebt samt ICE-Agent
      // bis zum Seitenende weiter, und ihr `onicecandidate` schösse über das
      // Singleton-`#sendSignal` in die NÄCHSTE Sitzung. Identitätsgeprüft
      // nullen — `this.#pc` kann inzwischen schon zu einer neuen Sitzung
      // gehören.
      if (pc.connectionState === 'failed') {
        console.info('[remote-p2p] Verbindung fehlgeschlagen — Serverweg bleibt');
        pc.onicecandidate = null;
        pc.close();
        if (this.#pc === pc) {
          this.#pc = null;
          this.#dc = null;
          // Präziser als der Browser es hergibt, wird es nicht: „failed"
          // heißt, keine der probierten Routen trug — der klassische Fall
          // sind strenge Router/Provider-NAT auf mindestens einer Seite.
          this.#status('Serverweg — Direktverbindung fehlgeschlagen (Router/NAT)');
        }
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
      this.#status('Serverweg — Direktverbindung fehlgeschlagen (kein WebRTC?)');
    }
  }

  async #antworten(data: unknown): Promise<void> {
    // Genau EIN Angebot je Sitzung (Bughunt 2026-08-13): jedes weitere baute
    // eine neue PeerConnection, ohne die alte zu schließen — der Gateway lässt
    // 60 Signale/s durch, und wer die Maus führen darf, soll nicht nebenbei
    // den WebRTC-Stack des Hosts erschöpfen können. Verhandelt wird nicht neu;
    // scheitert der Kanal, trägt der Serverweg.
    if (this.#pc !== null) return;
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
      // Gedeckelt: ein Gegenüber, das trickelt, aber nie antwortet, füllte
      // den Puffer sonst über die ganze Sitzungsdauer. Ein echter
      // Trickle-Schwall sind einige Dutzend Kandidaten.
      if (this.#eisPuffer.length < 64) this.#eisPuffer.push(kandidat);
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
    // VOLLSTÄNDIG (Bughunt 2026-08-13 — es fehlten Base64-Prüfung und
    // 1024-Byte-Deckel je Frame). Der Unterschied ist nicht kosmetisch: was
    // hier durchrutscht, trifft im Sidecar auf fail-closed und beendet die
    // ganze Sitzung; über den Serverweg kostete dieselbe kaputte Nachricht
    // nur ein 4050. Eine Grenzüberschreitung kostet eine Nachricht, nie die
    // Sitzung. Die eigentliche Autorisierung macht der eingehängte Pfad —
    // derselbe `eingabe()`-Wächter, den auch der Serverweg passiert.
    if (typeof msg.session_id !== 'string' || msg.session_id !== this.#sessionId) return;
    if (!Array.isArray(msg.frames) || msg.frames.length === 0) return;
    if (msg.frames.length > MAX_FRAMES) return;
    let summe = 0;
    for (const f of msg.frames) {
      const bytes = typeof f === 'string' ? frameBytes(f) : null;
      if (bytes === null) return;
      summe += bytes;
    }
    if (summe > MAX_NACHRICHT_BYTES) return;
    // Der Slot wird NICHT zurechtgebogen (Wire-Spec: „ein verbogener Platz
    // wäre ein Klick auf dem falschen Bildschirm") — ungültig heißt verwerfen,
    // wie beim Gateway. Obergrenze wie dort (`SLOT_MAX`, s. state.svelte.ts
    // `MAX_STREAM_SLOTS`).
    const slot = msg.slot;
    if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0 || slot > SLOT_MAX) {
      return;
    }
    this.#frameSink?.({
      session_id: msg.session_id,
      slot,
      frames: msg.frames as string[],
    });
  }

}

export const remoteP2P = new RemoteP2P();
