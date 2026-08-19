/**
 * Dauerhafter Halter für eine HQ-WHEP-Wiedergabe — überlebt das Wegnavigieren.
 *
 * Problem vorher: Die WHEP-Verbindung (RTCPeerConnection + MediaStream) lebte
 * IN der `WhepPlayer`-Komponente. Beim Verlassen des Channel-Bildschirms (z.B.
 * in eine DM) unmountete der Player → Verbindung gekappt → beim Zurückkommen
 * voller Reconnect (~1-2 s + evtl. Wackler).
 *
 * Jetzt: Die Verbindung + der Audio-Graph gehören diesem Manager, der NICHT am
 * Bildschirm hängt. Der Ton läuft über den Web-Audio-Graphen weiter, auch wenn
 * gerade kein `<video>` gemountet ist. Kommt der Viewer zurück, hängt der
 * Player nur sein Video-Element wieder an den schon laufenden MediaStream →
 * Bild sofort da, kein Reconnect.
 *
 * Lebensdauer wird vom `openedTiles`-Zustand bestimmt (siehe
 * `HqStreamKeepAlive.svelte`), NICHT vom Mounten/Unmounten des Players:
 * geschlossen wird, wenn der Viewer die Kachel zumacht ODER den Voice-Channel
 * verlässt/wechselt.
 *
 * Das Video ist IMMER stumm — der Ton kommt ausschließlich aus dem Web-Audio-
 * Graphen (`VolumeBoost`) bzw. dem Fallback-`<audio>`-Element. Dadurch ist der
 * Ton vom Video-Element entkoppelt und läuft beim Wegnavigieren weiter.
 */
import { connectWhep, WhepError, type WhepSession } from './whep';
import { DiagnoseSammler } from './diagnose-bericht';
import { sendeDiagnoseBericht } from './diagnose-senden';
import { WhepStatsReader, type StreamStats } from './whep-stats';
import { VolumeBoost } from './volumeBoost';
import { getStreamVolume, setStreamVolume } from './streamVolume';
import { FreezeRecycler, FREEZE_RECYCLE_MAX } from './freezeRecycle';
import { chatApi } from '$lib/api/chat';
import { isPlayerAvailable } from '$lib/player/client';
import { m } from '$lib/paraglide/messages.js';

// Retry-Backoff: Publisher evtl. noch nicht online (404) oder transienter
// Netz-Aussetzer. ICE-Watchdog wie zuvor im WhepPlayer.
const RETRY_MS = [1000, 2000, 3000, 5000, 5000];
const CONNECT_TIMEOUT_MS = 7000;
// "Connected but black at startup": RTP arrives but the decoder never makes a
// single frame — early connect to a just-started publish before MediaMTX has a
// keyframe cached. If still zero decoded frames this long after connecting,
// tear down + reconnect to pick up the now-cached keyframe. Disarms the moment
// any frame decodes, so it never fights a brief mid-playback freeze (a black
// *picture* still decodes black frames, so it's unaffected too).
const STALL_RECONNECT_MS = 3500;

export type StreamPhase = 'connecting' | 'playing' | 'retrying' | 'error';

export class ManagedHqStream {
  readonly channelId: string;
  readonly userId: string;
  /** Which of the user's streams this plays (0 = primary, 1 = a second one). */
  readonly slot: number;

  phase = $state<StreamPhase>('connecting');
  detail = $state<string>('');
  stats = $state<StreamStats | null>(null);
  audioBlocked = $state(false);
  /** Eingehender MediaStream — das Player-`<video>` hängt sich hier dran. */
  stream = $state<MediaStream | null>(null);
  volume = $state(100);
  /**
   * Sendet dieser Stream mit 10 bit je Farbkanal? Aus der WHEP-Antwort, also
   * bekannt BEVOR etwas dekodiert ist.
   *
   * Der Zuschauer hat hier keine Wahl: dieses `<video>` kann 10 bit nicht
   * darstellen, nur das eigene Fenster kann es (`useNativePlayback`). `false`
   * heisst „8 bit oder noch nicht bekannt" — nie „bestimmt nicht".
   */
  tenBit = $state(false);
  /** Kann der Streamer dieses Streams ferngesteuert werden? Aus der
   *  WHEP-Antwort (`remote_input`), die ihn vom Sidecar des Streamers
   *  durchreicht. Nur der Windows-Sidecar kann Eingaben einspielen — bei allen
   *  anderen bleibt der Anfrage-Knopf weg, statt eine Zustimmung einzuholen und
   *  danach zu scheitern. */
  fernsteuerbar = $state(false);

  #session: WhepSession | null = null;
  #connListener: ((this: RTCPeerConnection, ev: Event) => void) | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #connectTimer: ReturnType<typeof setTimeout> | undefined;
  #statsTimer: ReturnType<typeof setInterval> | undefined;
  #statsReader = new WhepStatsReader();
  /**
   * Sammelt die Zuschauersicht der laufenden Sitzung. `null`, solange keine
   * Sitzung läuft.
   *
   * Einer je WHEP-Sitzung, nicht je Manager: ein Wiederaufbau (`recycle`) ist
   * eine NEUE Sitzung mit eigenen Zählern — die WebRTC-Statistiken beginnen
   * dort bei null, ein durchgehender Sammler würde die Zähler-Sprünge als
   * riesige negative Deltas sehen.
   */
  #diagnose: DiagnoseSammler | null = null;
  #boost = new VolumeBoost();
  // Fallback-Audiosenke, falls der Web-Audio-Graph nicht greift (kein
  // AudioContext / kein Audio-Track) — bleibt auch ohne Video am Leben.
  #audioEl: HTMLAudioElement | null = null;
  #attempt = 0;
  #disposed = false;
  #videoEl: HTMLVideoElement | null = null;
  // Startup-black watchdog (see STALL_RECONNECT_MS): monotonic ms when "playing
  // but still zero decoded frames" began (0 = not currently stalled).
  #stalledSince = 0;
  // Wiedereinstieg bei anhaltendem Einfrieren (s. `freezeRecycle.ts`). Lebt am
  // Manager und nicht an der Sitzung — sonst stünde die Zahl nach jedem
  // Neuaufbau wieder auf null und die Grenze griffe nie.
  #freeze = new FreezeRecycler();
  // Letzte Nicht-Null-Lautstärke für den Mute-Toggle.
  #prevVolume = 100;

  constructor(channelId: string, userId: string, slot = 0) {
    this.channelId = channelId;
    this.userId = userId;
    this.slot = slot;
    const v = getStreamVolume(userId);
    this.volume = v;
    this.#prevVolume = v > 0 ? v : 100;
    this.#boost.onStateChange = (suspended) => {
      this.audioBlocked = suspended;
    };
    void this.#start();
  }

  // ---- Video-Anbindung (Bild) --------------------------------------------
  attachVideo(el: HTMLVideoElement): void {
    this.#videoEl = el;
    if (this.stream) {
      el.srcObject = this.stream;
      el.muted = true; // Ton läuft über den Web-Audio-Graphen, nie übers Video.
      void el.play().catch(() => {});
    }
  }

  detachVideo(el: HTMLVideoElement): void {
    if (this.#videoEl === el) {
      el.srcObject = null;
      this.#videoEl = null;
    }
  }

  // ---- Lautstärke ---------------------------------------------------------
  /**
   * Gibt der native Player den Ton aus? Dann schweigt dieser Weg.
   *
   * Ohne das liefe der Ton DOPPELT: das eigene Fenster dekodiert Opus selbst
   * (cpal) und diese Verbindung tut es auch — und der Schieber in der Kachel
   * würde nur die Hälfte davon regeln. Gesetzt wird es von der
   * `NativePlayerSession`, nicht von der Kachel: das Fenster überlebt deren
   * Unmount (Keep-Alive), und beim Aushängen dürfte der Ton nicht wieder
   * doppelt anlaufen.
   */
  nativeAudio = $state(false);

  setNativeAudio(on: boolean): void {
    if (this.nativeAudio === on) return;
    this.nativeAudio = on;
    this.#applyVolume();
  }

  // ---- Ruhen, solange das eigene Fenster den Stream hat --------------------
  /**
   * Läuft das Bild im nativen Player, ruht diese Verbindung.
   *
   * **KORREKTUR 2026-08-13 gegenüber der ersten Fassung.** Hier stand, die
   * Kachel habe bei JEDEM Stream im eigenen Fenster weiter mitdekodiert und das
   * sei die Ursache der GPU-Hänger auf AMD. Beides war falsch:
   *
   * * Für **fremde** Streams klemmt `HqStreamKeepAlive.svelte` die Verbindung
   *   schon seit dem 2026-08-03 ab — `imFenster()` nimmt den Stream aus
   *   `wanted`, und `reconcile` schliesst den Manager dann ganz. Nachgeprüft
   *   bis `pc.close()`. Für diesen Fall ist das hier nur einen Microtask
   *   früher, also wirkungslos.
   * * Die GPU-Hänger sind damit NICHT erklärt. Die vier Vorfälle mit
   *   `Process electron` am 2026-08-12 liegen 26 bis 32 Sekunden NACH dem
   *   Schliessen des Fensters — die Kachel hatte planmässig übernommen und war
   *   der einzige Decoder. Die Auftragszählung des Rings stützt das: rund
   *   41 Aufträge je Sekunde, also einer statt zweier Decoder.
   *
   * **Hier stand bis zum 2026-08-19: „Wofür es trotzdem gebraucht wird: den
   * EIGENEN Stream" — samt dem Hinweis, der eigentliche Fehler sitze eine
   * Ebene höher und gehöre behoben. Er ist behoben, der Absatz gilt nicht
   * mehr.**
   *
   * `HqStreamKeepAlive.svelte` nahm den eigenen Stream aus `wanted` heraus,
   * während `WhepPlayer.svelte` ihn beim Mounten über `hqStreams.ensure()`
   * trotzdem anlegte. Erzeuger und Eigentümer widersprachen sich also: der
   * Abgleicher schloss sofort wieder, der nächste Effect-Lauf legte neu an.
   * Das kostete Bandbreite auf der Sendeleitung und lieferte trotzdem kein
   * brauchbares Selbstbild. Seit dem 2026-08-19 hängt der eigene Stream an
   * derselben Bedingung wie jeder fremde — an `openedTiles`, also an der
   * ausdrücklichen Absicht des Nutzers.
   *
   * Am Messstand nachgewiesen: ohne Zuschauer keine Lesesitzung, beim Anklicken
   * genau eine (stabil über 45 s), beim Wegklicken wieder keine.
   *
   * `setRuhend` bleibt davon unberührt und wird weiter gebraucht — für JEDEN
   * Stream, der ins eigene Fenster übernommen wird: sonst dekodieren Browser
   * und Fenster dasselbe Bild doppelt auf einer Video-Einheit.
   *
   * Gesetzt wird es von der `NativePlayerSession`, nicht von der Kachel: das
   * Fenster überlebt deren Unmount (Keep-Alive), und nur sie kennt den Zustand
   * `playing`.
   */
  ruhend = $state(false);

  setRuhend(on: boolean): void {
    if (this.ruhend === on) return;
    this.ruhend = on;
    if (on) void this.#ruhenLegen();
    else void this.#aufwecken();
  }

  /**
   * Verbindung abbauen, Manager behalten.
   *
   * Lautstärke, Registry-Eintrag und Keep-Alive bleiben bestehen — es geht nur
   * die WHEP-Sitzung. `phase` fällt auf `connecting` zurück: käme die Kachel
   * später zurück, zeigte ein stehengebliebenes `playing` sonst einen Zustand
   * an, hinter dem kein Bild mehr steht.
   *
   * Der Zustand wird VOR dem `await` gesetzt — `#teardown()` merkt sich die
   * Sitzung synchron und schliesst danach, ein zwischenzeitliches Aufwecken
   * kann seine frische Sitzung also nicht mehr verlieren.
   */
  async #ruhenLegen(): Promise<void> {
    this.#removeAudioEl();
    this.stream = null;
    this.stats = null;
    this.phase = 'connecting';
    this.detail = '';
    await this.#teardown('uebernahme');
  }

  /** Zurück auf den Kachel-Weg: das Fenster ist zu oder gescheitert. */
  async #aufwecken(): Promise<void> {
    if (this.#disposed || this.ruhend) return;
    this.#attempt = 0;
    await this.#start();
  }

  setVolume(v: number): void {
    if (v > 0) this.#prevVolume = v;
    this.volume = v;
    this.#applyVolume();
    setStreamVolume(this.userId, v);
  }

  toggleMute(): void {
    const next = this.volume > 0 ? 0 : this.#prevVolume > 0 ? this.#prevVolume : 100;
    if (this.volume > 0) this.#prevVolume = this.volume;
    this.setVolume(next);
  }

  async enableAudio(): Promise<void> {
    try {
      await this.#boost.resume();
      await this.#audioEl?.play();
      this.audioBlocked = this.#boost.suspended;
    } catch {
      /* still blocked */
    }
  }

  #applyVolume(): void {
    // Der ANGEZEIGTE Wert bleibt erhalten (`this.volume`) — er gilt dann für
    // den Player, der ihn über `set_option` bekommt.
    const v = this.nativeAudio ? 0 : this.volume / 100;
    if (this.#audioEl) this.#audioEl.volume = Math.min(1.0, v);
    this.#boost.setVolume(v);
  }

  // ---- Audio-Senke --------------------------------------------------------
  #ensureAudioEl(): HTMLAudioElement {
    if (!this.#audioEl) {
      const el = document.createElement('audio');
      el.autoplay = true;
      el.style.display = 'none';
      document.body.appendChild(el);
      this.#audioEl = el;
    }
    return this.#audioEl;
  }

  #removeAudioEl(): void {
    if (this.#audioEl) {
      this.#audioEl.srcObject = null;
      this.#audioEl.remove();
      this.#audioEl = null;
    }
  }

  #onStream(stream: MediaStream): void {
    // Auch hier `ruhend` mitprüfen: der Rückruf feuert MITTEN in `connectWhep`.
    // Ist inzwischen das eigene Fenster eingesprungen, gehört dieser Strom zu
    // einer Sitzung, die gleich wieder geschlossen wird — würde er trotzdem
    // angehängt, bliebe ein Audio-Element mit totem `srcObject` stehen und
    // `this.stream` zeigte auf einen Strom, den es nicht mehr gibt.
    if (this.#abgebrochen()) return;
    this.stream = stream;
    // Audio bevorzugt über den Web-Audio-Graphen (boost) — läuft unabhängig vom
    // Video-Element weiter. Greift der nicht, Fallback auf ein verstecktes,
    // ungemutetes <audio>-Element (auch dauerhaft, ohne Video).
    if (this.#boost.attach(stream)) {
      this.audioBlocked = this.#boost.suspended;
      this.#removeAudioEl();
    } else {
      const el = this.#ensureAudioEl();
      el.srcObject = stream;
      el.muted = false;
      void el.play().catch(() => {});
    }
    if (this.#videoEl) {
      this.#videoEl.srcObject = stream;
      this.#videoEl.muted = true;
      void this.#videoEl.play().catch(() => {});
    }
    this.#applyVolume();
  }

  // ---- WHEP-Verbindung (aus WhepPlayer übernommen) ------------------------
  #clearTimers(): void {
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    clearTimeout(this.#connectTimer);
    this.#connectTimer = undefined;
    clearInterval(this.#statsTimer);
    this.#statsTimer = undefined;
  }

  /**
   * Schliesst die Diagnose der laufenden Sitzung ab und schickt sie los.
   *
   * Hier und nicht im `close()`: `#teardown()` ist die EINZIGE Stelle, durch
   * die jedes Sitzungsende läuft — das gewollte Schliessen der Kachel ebenso
   * wie der Wiederaufbau nach einem Abbruch. Am `close()` allein hinge der
   * Bericht genau bei den Sitzungen nicht, die abbrachen, also bei denen, um
   * die es geht.
   *
   * `void` und kein `await`: der Versand ist Beiwerk und darf den Abbau nicht
   * aufhalten. Dass er trotzdem ankommt, wenn nebenher die Seite abgeräumt
   * wird, besorgt `keepalive` in `diagnose-senden.ts`.
   */
  #diagnoseAbschliessen(grund: string): void {
    const sammler = this.#diagnose;
    this.#diagnose = null;
    if (!sammler || !sammler.lohntSich()) return;
    // **`uebernahme` zählt wie ein reguläres Ende, nicht wie ein Fehler.** Sie
    // ist ein geplanter Wechsel: das eigene Fenster übernimmt, die Verbindung
    // wird absichtlich abgebaut. Ohne diese Zeile wurde seit dem 2026-08-13
    // JEDE Fensterübernahme als Fehlerbericht abgesetzt — besonders zuverlässig
    // dann, wenn die Kachel noch gar kein Bild dekodiert hatte, denn genau dann
    // hält `lohntSich()` den Bericht für interessant. Das verrauscht die
    // Sammlung, die echte Abbrüche finden soll.
    const planmaessig = grund == 'beendet' || grund == 'uebernahme';
    void sendeDiagnoseBericht(sammler.bericht(grund), planmaessig ? 'stream_end' : 'error');
  }

  async #teardown(grund = 'wiederaufbau'): Promise<void> {
    this.#clearTimers();
    // `disposed` heisst: die Kachel wurde geschlossen. Alles andere, was hier
    // durchkommt, ist ein Wiederaufbau oder die Übernahme durch das eigene
    // Fenster (`uebernahme`) — und beides hat einen Grund, der in den Bericht
    // gehört: ein als `wiederaufbau` gebuchtes Ruhen sähe im Nachhinein wie ein
    // Verbindungsabbruch aus.
    this.#diagnoseAbschliessen(this.#disposed ? 'beendet' : grund);
    const s = this.#session;
    this.#session = null;
    if (s && this.#connListener) {
      s.pc.removeEventListener('connectionstatechange', this.#connListener);
    }
    this.#connListener = null;
    if (s) await s.close();
  }

  #scheduleRetry(): void {
    if (this.#disposed) return;
    const wait = RETRY_MS[Math.min(this.#attempt, RETRY_MS.length - 1)];
    this.#attempt += 1;
    this.phase = 'retrying';
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.#start();
    }, wait);
  }

  /**
   * Meldet dem Wiedereinstieg den frischen Messwert und setzt seine
   * Entscheidung um. `true` = die Sitzung soll erneuert werden.
   */
  #handleFreeze(next: StreamStats): boolean {
    switch (this.#freeze.decide(next, performance.now())) {
      case 'erneuern':
        console.warn(
          `[whep] eingefroren seit ${next.freezeSeconds.toFixed(1)} s — Sitzung wird erneuert ` +
            `(${this.#freeze.versuche}/${FREEZE_RECYCLE_MAX})`,
          next.diagnostic,
        );
        return true;
      case 'aufgeben':
        // Nur EINMAL umschalten: sonst überschriebe jede Sekunde denselben
        // Zustand und ein späterer Retry-Versuch käme nie durch.
        if (this.phase !== 'error') {
          this.phase = 'error';
          this.detail = m.hq_stream_frozen_give_up();
          console.warn('[whep] dauerhaft eingefroren, aufgegeben', next.diagnostic);
        }
        return false;
      case 'weiter':
        return false;
    }
  }

  /**
   * Ist der Aufbau, der gerade läuft, inzwischen gegenstandslos?
   *
   * `#disposed` = die Kachel ist geschlossen, `ruhend` = das eigene Fenster hat
   * übernommen. Beides muss nach JEDEM `await` in `#start` geprüft werden — die
   * Begründung steht dort.
   */
  #abgebrochen(): boolean {
    return this.#disposed || this.ruhend;
  }

  async #start(): Promise<void> {
    // `ruhend` gehört hierher und nicht nur an die Aufrufstellen: ein bereits
    // laufender Retry-Timer (`#scheduleRetry`) würde die Verbindung sonst
    // wieder aufbauen, während das eigene Fenster den Stream hat.
    if (this.#disposed || this.ruhend) return;
    await this.#teardown();
    // **Nach jedem `await` erneut auf `ruhend` prüfen, nicht nur auf
    // `#disposed`.** Der Wettlauf: `setRuhend(true)` stösst `#ruhenLegen` →
    // `#teardown` an. Fällt das in ein Fenster, in dem hier gerade ein `await`
    // hängt, findet jenes `#teardown` `#session === null` vor und schliesst
    // nichts — anschliessend hängt dieser Lauf seine frisch aufgebaute, LEBENDE
    // Sitzung in einen Manager, der sich für ruhend hält. Sie bleibt bis
    // `close()`/`reconcile` offen. Erkennbar ist das Leck am Server: MediaMTX
    // zeigt zwei gleichzeitige Lesesitzungen auf demselben Pfad, obwohl nur ein
    // Zuschauer da ist — und jede kostet Bandbreite auf genau der Leitung, die
    // beim Streamen ohnehin der Engpass ist.
    if (this.#abgebrochen()) return;
    if (this.#attempt === 0) this.phase = 'connecting';
    try {
      const { whep_url, ten_bit, remote_input } = await chatApi.getWhepUrl(
        this.channelId,
        this.userId,
        this.slot,
      );
      // Die Bittiefe entscheidet, OB dieser Weg ueberhaupt der richtige ist:
      // ein 10-bit-Strom laesst sich hier nicht in 10 bit anzeigen (Chromium
      // legt seinen Puffer als 8 bit an, gemessen 2026-07-26). Der Wert muss
      // deshalb hier haengenbleiben — die Kachel kann ihn sonst nirgends
      // erfahren, solange das eigene Fenster nicht laeuft, und genau das ist
      // die Lage, in der die Entscheidung faellt.
      this.tenBit = ten_bit === true;
      this.fernsteuerbar = remote_input === true;
      if (this.#abgebrochen()) return;
      // **10 bit ohne eigenes Fenster: gar nicht erst verbinden.**
      //
      // Warum ABLEHNEN und nicht „so gut es geht anzeigen": beides waere
      // vertretbar, wenn der `<video>`-Weg 10 bit nur heruntergerechnet
      // zeigte. Er tut etwas anderes. Gemessen am 2026-08-01
      // (`streaming/testbench/profiles/browser-2026-08-01-windows-av1-10bit.json`,
      // ausgewertet in `intrarefresh-2026-08-02-windows-amd.json` Abschnitt 9):
      // Chromes Hardware-Decoder steigt MITTEN im Lauf aus, libwebrtc faellt
      // auf `dav1d` zurueck, und der kann kein 10 bit
      // (`Dav1dDecoder::Decode unhandled bit depth: 10`). Ab da ist der Strom
      // endgueltig undekodierbar — und der Zuschauer fordert endlos Vollbilder
      // an (425 in einem einzigen Lauf). Der Schaden trifft also nicht nur
      // diesen Zuschauer, sondern jeden anderen im selben Stream. Eine
      // ehrliche Absage mit einem Weg nach vorne ist besser als ein Bild, das
      // sich in ein Standbild verwandelt und dabei die Runde mitnimmt.
      //
      // **Warum nicht senderseitig aushandeln** („10 bit nur anbieten, wenn
      // der Zuschauer es tragen kann"): es gibt EINEN Encode fuer alle
      // Zuschauer, MediaMTX verteilt ihn nur. Pro Zuschauer eine Bittiefe
      // hiesse eine zweite Kodierung — Transcoding auf dem Server ist in
      // `PLAN.md` §12 ausdruecklich ausgeschlossen. Was senderseitig moeglich
      // und deshalb zusaetzlich gebaut ist: der Streamer erfaehrt beim
      // Einstellen, was 10 bit fuer Browser-Zuschauer bedeutet
      // (`OverridesEditor.svelte`).
      //
      // `ten_bit` steht aus der WHEP-Antwort fest, BEVOR etwas dekodiert ist —
      // die Entscheidung faellt also ohne einen einzigen falschen Frame.
      // `isPlayerAvailable` liefert im Browser immer `false` und wirft nie —
      // die Abfrage ist also auch dort unbedenklich.
      if (this.tenBit && !(await isPlayerAvailable())) {
        if (this.#abgebrochen()) return;
        this.phase = 'error';
        this.detail = m.hq_stream_ten_bit_needs_desktop();
        return;
      }
      if (this.#abgebrochen()) return;
      const s = await connectWhep(whep_url, (stream) => this.#onStream(stream));
      if (this.#abgebrochen()) {
        // Hier wird wirklich geschlossen und nicht bloss die Referenz fallen
        // gelassen: die Sitzung steht zu diesem Zeitpunkt schon, und `#teardown`
        // bekommt sie nie zu sehen — sie war nie in `#session`. Ohne das
        // `close()` wäre das Leck nur von der einen Stelle an die andere
        // gerückt.
        await s.close();
        return;
      }
      this.#session = s;
      const onConnected = () => {
        clearTimeout(this.#connectTimer);
        this.#connectTimer = undefined;
        this.#attempt = 0;
        this.phase = 'playing';
        this.detail = '';
      };
      const recycle = () => {
        void this.#teardown().then(() => {
          if (!this.#disposed) this.#scheduleRetry();
        });
      };
      this.#connListener = () => {
        if (this.#disposed || this.#session !== s) return;
        const st = s.pc.connectionState;
        // Auch die transienten Zustände mitschreiben. Gerade eine Kette
        // `disconnected → connected` ist eine Aussage über die Leitung, die
        // sonst nirgends auftaucht — der Zuschauer merkt davon nichts, und
        // ohne den Eintrag sieht der Bericht später aus wie eine ruhige
        // Sitzung mit unerklärlichem Ruckeln.
        this.#diagnose?.verbindung(st);
        // `disconnected` ist transient (Chromium erholt sich meist) — nur bei
        // den endgültigen Zuständen neu aufbauen.
        if (st === 'connected') onConnected();
        else if (st === 'failed' || st === 'closed') recycle();
      };
      s.pc.addEventListener('connectionstatechange', this.#connListener);
      if (s.pc.connectionState === 'connected') {
        onConnected();
      } else {
        this.#connectTimer = setTimeout(() => {
          this.#connectTimer = undefined;
          if (this.#disposed || this.#session !== s) return;
          if (s.pc.connectionState !== 'connected') recycle();
        }, CONNECT_TIMEOUT_MS);
      }
      this.#statsReader.reset();
      this.#stalledSince = 0;
      this.#diagnose = new DiagnoseSammler({
        kanal: this.channelId,
        sender: this.userId,
        slot: this.slot,
        zehnBit: this.tenBit,
      });
      this.#statsTimer = setInterval(async () => {
        const cur = this.#session;
        if (!cur) return;
        const next = await this.#statsReader.read(cur.pc);
        // Während des read()-Awaits kann ein Reconnect (teardown→start) den
        // Session-PeerConnection ausgetauscht oder den Manager entsorgt haben —
        // dann gehören die Stats zum alten PC, nicht überschreiben.
        if (this.#disposed || this.#session !== cur) return;
        this.stats = next;
        this.#diagnose?.beobachte(next);
        // Startup-black watchdog: while playing but no frame has EVER decoded,
        // reconnect once the stall passes the threshold. Disarms permanently as
        // soon as the first frame decodes (mid-stream stalls are the connection-
        // state handler's job, not this).
        if (this.phase === 'playing' && next) {
          if (next.diagnostic.framesDecoded > 0) {
            this.#stalledSince = 0;
          } else if (this.#stalledSince === 0) {
            this.#stalledSince = performance.now();
          } else if (performance.now() - this.#stalledSince > STALL_RECONNECT_MS) {
            this.#stalledSince = 0;
            recycle();
          }
          if (this.#handleFreeze(next)) recycle();
        }
      }, 1000);
    } catch (e) {
      if (this.#disposed) return;
      const status = e instanceof WhepError ? e.status : 0;
      this.detail = e instanceof Error ? e.message : String(e);
      if (status === 404 || status === 0 || status >= 500) {
        this.#scheduleRetry();
      } else {
        this.phase = 'error';
      }
    }
  }

  close(): void {
    this.#disposed = true;
    void this.#teardown();
    this.#boost.dispose();
    this.#removeAudioEl();
    this.stream = null;
  }
}

// ---- Registry -------------------------------------------------------------

const registry = new Map<string, ManagedHqStream>();
const keyOf = (channelId: string, userId: string, slot: number) =>
  `${channelId}:${userId}:${slot}`;

export const hqStreams = {
  /** Bestehenden Manager holen oder neu anlegen (idempotent). */
  ensure(channelId: string, userId: string, slot = 0): ManagedHqStream {
    const k = keyOf(channelId, userId, slot);
    let m = registry.get(k);
    if (!m) {
      m = new ManagedHqStream(channelId, userId, slot);
      registry.set(k, m);
    }
    return m;
  },

  get(channelId: string, userId: string, slot = 0): ManagedHqStream | null {
    return registry.get(keyOf(channelId, userId, slot)) ?? null;
  },

  close(channelId: string, userId: string, slot = 0): void {
    const k = keyOf(channelId, userId, slot);
    const m = registry.get(k);
    if (m) {
      m.close();
      registry.delete(k);
    }
  },

  /**
   * Soll-Zustand abgleichen: für jeden gewünschten Stream (channel, user, slot)
   * einen Manager sicherstellen, alle übrigen schließen. Treiber = `openedTiles`
   * (siehe `HqStreamKeepAlive.svelte`).
   */
  reconcile(wanted: { channelId: string; userId: string; slot: number }[]): void {
    const wantedKeys = new Set(wanted.map((w) => keyOf(w.channelId, w.userId, w.slot)));
    for (const k of [...registry.keys()]) {
      if (!wantedKeys.has(k)) {
        registry.get(k)!.close();
        registry.delete(k);
      }
    }
    for (const w of wanted) this.ensure(w.channelId, w.userId, w.slot);
  }
};
