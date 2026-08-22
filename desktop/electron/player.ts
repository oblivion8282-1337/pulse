/**
 * Bruecke zum nativen HQ-Player (`streaming/pulse-player/`).
 *
 * Gleiches stdio-JSON-RPC wie `sidecar.ts`, aber ein anderer Zweck: der Player
 * EMPFAENGT einen Stream und stellt ihn in einem eigenen Fenster dar, statt ihn
 * aufzunehmen. Grund fuer die Existenz siehe `streaming/pulse-player/README.md`
 * — kurz: Chromium gibt auf Wayland immer 8 bit aus und nutzt auf NVIDIA kein
 * NVDEC; beides entscheidet der Player selbst.
 *
 * WICHTIG — er ist rein additiv. Fehlt das Binary oder scheitert der Start,
 * meldet `isAvailable()` schlicht `false` und der Renderer bleibt auf dem
 * bestehenden WHEP-Weg im `<video>`-Element. Hier darf nie etwas werfen, das
 * die App beeintraechtigt.
 *
 * **Alles Diagnostische geht zusaetzlich in `sidecar.log`** (`logSidecar`, s.
 * `sidecar-log.ts`). Bis 2026-08-05 ging es ausschliesslich nach `console.*` —
 * und im verpackten Build hat Electrons Konsole keinen Abnehmer: die Ausgabe
 * landete nirgends. Damit war nach einem Bild-Fehler beim Nutzer NICHT
 * nachvollziehbar, was der Player getan hat (welcher Decoder, welche
 * Fehlermeldung, ob er ueberhaupt gestartet ist), obwohl der Datei-Logger
 * daneben schon lief und der Capture-Sidecar ihn benutzte. Beide schreiben
 * bewusst in DIESELBE Datei: ein HQ-Fehler betrifft fast immer beide Seiten,
 * und zwei Dateien haetten die Zeitzuordnung zwischen Senden und Empfangen
 * gekostet. Auseinanderzuhalten sind sie am `[pulse-player]`-Vorsatz.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { app } from 'electron';

import { diagnoseEingeschaltet } from './experimental-log-upload';
import { createHwdecWacht } from './player-hwdec-wacht';
import { createLeerlaufWacht } from './player-leerlauf';
import { logSidecar } from './sidecar-log';
import { befehlZeile } from './sidecar-log-befehle';

/**
 * Eine Zeile in beide Kanaele: Datei-Log (ueberlebt den verpackten Build) und
 * Konsole (im Dev-Lauf das, was man sofort sieht).
 *
 * Der `[pulse-player]`-Vorsatz steht IM Text und nicht nur in der Konsole,
 * damit er in der gemeinsamen Datei erhalten bleibt — sonst waeren
 * Player-Zeilen dort nicht von denen des Capture-Sidecars zu unterscheiden.
 */
function log(stream: 'in' | 'out' | 'err' | 'lifecycle', line: string): void {
  const text = `[pulse-player] ${line}`;
  logSidecar(stream, text);
  if (stream === 'err' || stream === 'lifecycle') console.error(text);
  else console.log(text);
}

const REQUEST_TIMEOUT_MS = 10_000;
/** `open` baut eine WebRTC-Verbindung auf — das darf laenger dauern. */
const OPEN_TIMEOUT_MS = 30_000;
/** Wartezeit auf die Antwort des `shutdown`-Ops. */
const SHUTDOWN_GRACE_MS = 2_000;
/** Nach SIGTERM, bevor hart beendet wird — gleiche Staffelung wie `sidecar.ts`. */
const SHUTDOWN_SIGTERM_GRACE_MS = 2_000;

/**
 * Wie lange der Player ohne ein einziges Fenster weiterlaufen darf. Wozu es
 * diese Frist gibt und warum nicht sofort beendet wird: `player-leerlauf.ts`.
 *
 * **Warum ausgerechnet 30 s.** Zwei gemessene Werte begrenzen das nach unten.
 * Im untersuchten Vorfall vom 2026-08-17 lagen **23 s** zwischen dem `close`
 * des einen und dem `open` des naechsten Fensters — der ferne Rechner musste
 * dazwischen geweckt werden und seinen Encoder hochfahren. Und die App selbst
 * wartet bis zu **25 s** auf das erste Bild, bevor sie aufgibt
 * (`web/src/lib/devices/schirme.svelte.ts`, `WARTEN_MS`). Eine kuerzere Frist
 * als diese 25 s erzwaenge einen Neustart ausgerechnet im langsamsten Fall, den
 * es regulaer gibt. 30 s liegt darueber und ist zugleich kurz genug, dass ein
 * unbenutzter Player keine halbe Stunde Speicher haelt.
 *
 * **Annahme, die falsch sein kann:** dass ein Neustart billig ist. Hier ist er
 * es (der Prozess selbst startet in Millisekunden, die Zeit geht in den
 * WebRTC-Aufbau, den es ohnehin braucht). Zeigt sich das auf schwachen
 * Maschinen anders, ist diese Zahl die Stellschraube — nicht das Abschalten.
 */
const LEERLAUF_MS = 30_000;

const BINARY_NAME = process.platform === 'win32' ? 'pulse-player.exe' : 'pulse-player';

type PlayerMessage = Record<string, unknown>;
type EventCallback = (ev: PlayerMessage) => void;

interface PendingRequest {
  resolve: (value: PlayerMessage) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Sucht das Binary. Reihenfolge bewusst wie bei den anderen Sidecars:
 *   1. `$PULSE_PLAYER_BIN` (nur in unverpackten Builds — sonst koennte eine
 *      manipulierte .desktop-Datei beliebige Programme starten)
 *   2. Dev: aufwaerts nach `streaming/pulse-player/target/release/…`
 *   3. Verpackt: `resources/hq-sidecar/` — dasselbe Verzeichnis wie der
 *      Capture-Sidecar (s.u., das ist unter Windows kein Schoenheitsfehler,
 *      sondern Bedingung)
 *   4. Plattform-Standard im Installationsverzeichnis
 *
 * **Warum der Player unter Windows im `hq-sidecar`-Verzeichnis liegt und nicht
 * in einem eigenen:** er linkt FFmpeg dynamisch, und Windows sucht die DLLs
 * eines Prozesses zuerst im Verzeichnis der EIGENEN ausfuehrbaren Datei — nicht
 * in dem der App. Die FFmpeg-DLLs liegen dort bereits fuer den Capture-Sidecar;
 * daneben zu ziehen kostet nichts, ein eigener Ordner haette dagegen eine
 * zweite Kopie derselben ~100 MB verlangt. Bis 2026-08-05 wurde er ueberhaupt
 * nicht mitgeliefert und diese Suche lief unter Windows daher immer ins Leere.
 *
 * **Seit 2026-08-20 gilt derselbe Punkt auch unter macOS**, nur ueber einen
 * anderen Mechanismus: dort loest `@loader_path` (statt einer Verzeichnis-Suche)
 * die dylibs relativ zum Binary auf, und `scripts/bundle-dylibs.sh` baut fuer
 * Sidecar UND Player bewusst EINEN gemeinsamen Dylib-Satz in `hq-sidecar/` —
 * ein eigener Player-Ordner haette wieder eine zweite Kopie derselben
 * FFmpeg-dylibs verlangt.
 *
 * Gibt `null` zurueck statt zu werfen: "nicht vorhanden" ist ein normaler
 * Zustand, kein Fehler.
 */
export function resolvePlayerBinary(): string | null {
  const override = !app.isPackaged ? process.env.PULSE_PLAYER_BIN : undefined;
  if (override) return fs.existsSync(override) ? override : null;

  if (!app.isPackaged) {
    // Vom kompilierten `electron/dist/` aus aufwaerts suchen, bis die Crate
    // gefunden ist. Tiefe grosszuegig, damit Worktrees mitgehen.
    let dir = __dirname;
    for (let i = 0; i < 8; i += 1) {
      const candidate = path.join(
        dir,
        'streaming',
        'pulse-player',
        'target',
        'release',
        BINARY_NAME,
      );
      if (fs.existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  const candidates: string[] = [];
  // Verpackte App: neben dem Capture-Sidecar unter `resources/hq-sidecar/`
  // (Begruendung im Kopf der Funktion). `process.resourcesPath` ist in jedem
  // Electron-Prozess gesetzt; im Dev-Lauf existiert der Pfad einfach nicht.
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'hq-sidecar', BINARY_NAME));
  }
  if (process.platform === 'linux') {
    candidates.push(`/app/bin/${BINARY_NAME}`);
  } else if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Pulse', 'hq-sidecar', BINARY_NAME));
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Pulse', BINARY_NAME));
  }
  // macOS und alles Uebrige: neben der ausfuehrbaren Datei.
  candidates.push(path.join(path.dirname(app.getPath('exe')), BINARY_NAME));

  return candidates.find((p) => fs.existsSync(p)) ?? null;
}


/**
 * Zielverzeichnis fuer Mitschnitte. Bewusst **nicht** vom Renderer gewaehlt:
 * ein frei uebergebener Pfad waere ein Schreibzugriff an beliebige Stelle.
 * Der Renderer loest nur aus, der Hauptprozess bestimmt wohin.
 */
function recordingDir(): string {
  const base = (() => {
    try {
      return app.getPath('videos');
    } catch {
      return app.getPath('userData');
    }
  })();
  const dir = path.join(base, 'Pulse');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Zeitstempel-Dateiname, kollisionsfrei und sortierbar. */
function recordingPath(kind: 'aufnahme' | 'clip'): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `_${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`;
  // Endung ist nur ein Vorschlag: der Player setzt sie passend zum Codec
  // (AV1 -> mkv, H.264 -> ts) und meldet den benutzten Pfad zurueck.
  return path.join(recordingDir(), `pulse-${kind}-${stamp}.ts`);
}

class PlayerManager {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private pending = new Map<number, PendingRequest>();
  private listeners = new Set<EventCallback>();
  private nextId = 1;
  /** Merkt einen gescheiterten Start, damit nicht bei jedem Aufruf neu probiert wird. */
  private startFailed = false;
  /**
   * Merkt einen GPU-Reset, damit der naechste Start die Hardware-Dekodierung
   * auslaesst. Begruendung im Kopf von `player-hwdec-wacht.ts`.
   */
  private hwdecWacht = createHwdecWacht();
  /**
   * Welche Fenster offen sind, und wann ohne sie Schluss ist.
   *
   * Gefuehrt aus dem Protokollstrom und nicht aus einem Zaehler im Renderer:
   * `open`, `close` und das vom Nutzer ausgeloeste `player:state closed` laufen
   * alle ueber dieselbe stdio-Leitung, und nur hier sind sie vollstaendig zu
   * sehen. Ein Renderer, der neu geladen wird, verloere seinen Stand.
   */
  private leerlauf = createLeerlaufWacht(LEERLAUF_MS, () => {
    log('lifecycle', `kein Fenster mehr seit ${LEERLAUF_MS / 1000} s — wird beendet`);
    void this.shutdown();
  });
  /**
   * Der Prozess, den WIR beenden — sein `exit` ist kein Stoerfall.
   *
   * Als Referenz auf den Kindprozess und nicht als `boolean`: `exit` kommt
   * asynchron, und ein Merker ohne Zuordnung koennte den Sturz eines
   * NACHFOLGERS verschlucken. Ohne diese Unterscheidung meldete jedes gewollte
   * Herunterfahren dem Renderer ein `failed`, und der verriegelt darauf den
   * eigenen Weg (`nativeFailed` in `useNativePlayback.svelte.ts`) — der Player
   * waere nach dem ersten Leerlauf bis zum naechsten Mount abgemeldet.
   */
  private gewollterAbbau: ChildProcessWithoutNullStreams | null = null;

  isAvailable(): boolean {
    if (this.startFailed) return false;
    return resolvePlayerBinary() !== null;
  }

  onEvent(cb: EventCallback): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Startet den Prozess beim ersten Bedarf. Wirft nur, wenn wirklich nichts geht. */
  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child;

    const binary = resolvePlayerBinary();
    if (!binary) {
      this.startFailed = true;
      // Der haeufigste Fall in einem verpackten Build (bis 2026-08-05 wurde das
      // Binary unter Windows gar nicht mitgeliefert) — und ohne diese Zeile
      // sieht man von aussen nur, dass das eigene Fenster „nicht verfuegbar" ist.
      log('lifecycle', 'Binary nicht gefunden — eigenes Fenster steht nicht zur Verfuegung');
      throw new Error('pulse-player nicht gefunden');
    }

    // **Die Statistik-Zeilen folgen dem Diagnose-Schalter.**
    //
    // Der Player kann seit dem 2026-08-07 je Sekunde melden, was der Sender
    // wirklich schickt (Vollbild-Zahl, -Abstand und -Groesse; bis zum
    // 2026-08-21 stand dort zusaetzlich eine Deutung „Vollbilder oder rollende
    // Auffrischung" — die Betriebsart ist entfallen, es sind nur noch Zahlen),
    // welche
    // Einstellungen wirklich gelten, wo zwischen Netz und Schirm die Bilder
    // liegenbleiben, und ob die Bilanz der Bilder aufgeht. Das alles hing an
    // `PULSE_PLAYER_STATS_LOG`, und dieser Schalter wurde von NIEMANDEM
    // gesetzt — die Zeilen waren gebaut, gemessen und im Betrieb nie zu sehen.
    // Ein Fehlerbericht enthielt damit genau das nicht, wofuer es ihn gibt.
    //
    // Gekoppelt an die Uebermittlung und nicht dauerhaft an: wer ihr zugestimmt
    // hat, will ein brauchbares Protokoll; wer sie abgewaehlt hat, soll auch
    // nichts zusaetzlich mitschreiben. Der Preis sind rund vier Zeilen je
    // Sekunde — der 512-KB-Ausschnitt des Uploads deckt damit noch etwa eine
    // Viertelstunde ab, und das ist bei einem Fehlerbericht der interessante
    // Zeitraum.
    //
    // Eine von aussen gesetzte Variable gewinnt: der Pruefstand faehrt den
    // Player mit eigenen Einstellungen, und die darf die App nicht ueberschreiben.
    const env = { ...process.env };
    if (env.PULSE_PLAYER_STATS_LOG === undefined && diagnoseEingeschaltet()) {
      env.PULSE_PLAYER_STATS_LOG = '1';
    }
    // Nach einem GPU-Reset ohne Hardware-Dekodierung weiter (s.
    // `player-hwdec-wacht.ts`); von aussen gesetzt gewinnt, wie oben.
    if (env.PULSE_PLAYER_HWDEC === undefined && this.hwdecWacht.hardwareAbgeschaltet()) {
      env.PULSE_PLAYER_HWDEC = '0';
    }
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], env });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    log('lifecycle', `gestartet pid=${child.pid ?? '?'} ${binary}`);

    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on('line', (line) => this.handleLine(line));

    // Diagnose des Players geht nach stderr und gehoert ins Electron-Log,
    // nicht in den Protokollstrom. Genau hier stehen die Zeilen, die einen
    // Bildfehler erklaeren: gewaehlter Decoder samt Hardware-Ja/Nein, die
    // FFmpeg-Meldungen, und mit `PULSE_PLAYER_STATS_LOG=1` die
    // Ausgabe-Abstaende.
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) log('err', line);
      }
    });

    child.on('exit', (code, signal) => {
      log('lifecycle', `beendet (code=${code}, signal=${signal})`);
      // **Vor der Zustaendigkeitspruefung, mit Absicht.** Ein GPU-Reset gilt
      // fuer die Karte, nicht fuer den Prozess, der ihn zufaellig gesehen hat —
      // stirbt ein abgeloester Vorgaenger daran, ist die naechste
      // Hardware-Dekodierung genauso betroffen. Diese Zeile hinter das `return`
      // zu schieben hiesse, den Sturz genau dann zu verlernen, wenn er
      // waehrend eines Fensterwechsels kommt.
      const gpuReset = this.hwdecWacht.absturzGemeldet(code, signal);
      if (gpuReset) {
        log(
          'lifecycle',
          'mit abort() beendet (GPU-Reset) — naechster Start ohne Hardware-Dekodierung',
        );
      }
      // **Nur aufraeumen, wenn dieser Prozess noch der aktuelle ist.** `exit`
      // kommt asynchron: nach einem `shutdown()` kann laengst ein neuer Player
      // laufen. Ohne diese Pruefung nahm der ALTE Prozess dem NEUEN beim
      // Sterben den Zeilenleser weg und setzte den Verweis auf null — der neue
      // lief dann weiter und antwortete auf nichts mehr, und alle offenen
      // Anfragen wurden faelschlich abgewiesen. Der `stdin`-Handler unten
      // prueft aus genau demselben Grund; hier fehlte es.
      if (this.child !== child) return;
      this.failAllPending(new Error('pulse-player wurde beendet'));
      this.rl?.close();
      this.rl = null;
      this.child = null;
      // Mit dem Prozess sind auch seine Fenster weg. Der naechste Start faengt
      // bei null an — bliebe hier ein Eintrag stehen, waere die Leerlauf-Frist
      // fuer den Nachfolger dauerhaft entschaerft.
      this.leerlauf.zuruecksetzen();
      // **Ein von uns gewolltes Ende ist kein Stoerfall.** Beim Leerlauf-Abbau
      // (und beim App-Ende) darf der Renderer kein `failed` sehen — s.
      // `gewollterAbbau`.
      if (this.gewollterAbbau === child) {
        this.gewollterAbbau = null;
        return;
      }
      // Laufende Sitzungen sind mit dem Prozess weg — den Renderer informieren,
      // damit er auf den Standardweg zurueckfaellt.
      //
      // **`reason` entscheidet, ob der Renderer es nochmal versucht.** Ohne das
      // Feld verriegelt er nach JEDEM `failed` (`nativeFailed` in
      // `useNativePlayback.svelte.ts`) und nimmt den Abkoppel-Knopf weg — der
      // Rueckfall auf Software-Dekodierung waere zwar scharf, aber niemand
      // wuerde ihn ausloesen, und die Kachel haenge bis zum naechsten Mount auf
      // Chromiums `<video>` (unter Wayland immer 8 bit). Seine bisherige
      // Begruendung fuers Nicht-Wiederholen — „derselbe Fehler nur wiederholen"
      // — trifft fuer genau diesen Fall nicht zu: der naechste Versuch laeuft
      // mit anderer Umgebung.
      this.emit({
        ev: 'player:state',
        state: 'failed',
        error: 'Player-Prozess beendet',
        ...(gpuReset ? { reason: 'gpu-reset' } : {}),
      });
    });

    // EPIPE-Fehler beim Schreiben auf einen gerade gestorbenen Kindprozess
    // kommen ASYNCHRON und werden vom try/catch um `write()` nicht gefangen.
    // Ohne Listener wirft Node sie unbehandelt — und das reisst den ganzen
    // Main-Prozess mit, nicht nur den Player. `sidecar.ts` hat denselben
    // Handler aus genau diesem Grund. Nur loggen: der 'exit'-Handler und die
    // Zeitueberschreitung raeumen die offenen Anfragen bereits auf.
    child.stdin.on('error', (err) => {
      if (this.child !== child) return;
      log('lifecycle', `stdin-Fehler: ${err.message}`);
    });

    child.on('error', (err) => {
      log('lifecycle', `Start fehlgeschlagen: ${err.message}`);
      // Gleiche Pruefung wie beim `exit`: ein sterbender Vorgaenger darf weder
      // den Player dauerhaft als "nicht verfuegbar" markieren noch die
      // Anfragen seines Nachfolgers abweisen.
      if (this.child !== child) return;
      this.startFailed = true;
      this.failAllPending(err);
    });

    this.child = child;
    return child;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: PlayerMessage;
    try {
      msg = JSON.parse(trimmed) as PlayerMessage;
    } catch {
      log('err', `unlesbare Zeile: ${trimmed.slice(0, 200)}`);
      return;
    }
    // Der Protokollstrom des Players ist duenn (Zustandswechsel, Knopfdruecke
    // im Fenster) — anders als beim Capture-Sidecar gibt es hier keine
    // fps-Flut, die auszuduennen waere. Deshalb vollstaendig mit.
    //
    // **Eine Ausnahme: die Eingabe-Frames der Fernsteuerung.** Die kommen bis zu
    // 125-mal je Sekunde und wuerden `sidecar.log` binnen Minuten fuellen —
    // damit waere der 512-KB-Ausschnitt des Diagnose-Uploads wertlos, weil
    // darin nichts anderes mehr staende. Ihr Inhalt taugt ohnehin nicht als
    // Diagnose: es sind Base64-Bytes. Dass eine Sitzung erfasst, steht am
    // `input_capture`-Aufruf.
    if (msg.ev !== 'player:input') log('out', trimmed);

    // Ereignis (`ev`) statt Antwort (`id`/`ok`) — gleiche Unterscheidung wie
    // bei den Capture-Sidecars.
    if (typeof msg.ev === 'string') {
      // Das Fensterkreuz meldet sich hier und NICHT als `close`-Op: der Nutzer
      // hat im Fenster geschlossen, die App erfaehrt es erst durch diese
      // Meldung. Ohne sie zaehlte nur, was die App selbst zumacht.
      if (msg.ev === 'player:state' && msg.state === 'closed' && typeof msg.session === 'number') {
        this.leerlauf.geschlossen(msg.session);
      }
      this.emit(msg);
      return;
    }

    const id = typeof msg.id === 'number' ? msg.id : null;
    if (id === null) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (msg.ok === false) {
      pending.reject(new Error(String(msg.error ?? 'unbekannter Fehler')));
    } else {
      pending.resolve(msg);
    }
  }

  private emit(msg: PlayerMessage): void {
    for (const cb of this.listeners) {
      try {
        cb(msg);
      } catch (err) {
        log('err', `Ereignis-Empfaenger warf: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private failAllPending(err: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  /** Schickt eine Operation und wartet auf die zugehoerige Antwort. */
  async call(op: string, params: Record<string, unknown> = {}): Promise<PlayerMessage> {
    // **Das `close` wird VOR der Antwort gebucht.** Wer schliesst, will das
    // Fenster los — ob der Player es bestaetigt, aendert daran nichts, und eine
    // Absage („unbekannte Sitzung") liesse den Eintrag sonst fuer immer stehen
    // und die Leerlauf-Frist nie anlaufen.
    if (op === 'close' && typeof params.session === 'number') {
      this.leerlauf.geschlossen(params.session);
    }

    const child = this.ensureStarted();
    const id = this.nextId;
    this.nextId += 1;

    const timeoutMs = op === 'open' ? OPEN_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
    const payload = JSON.stringify({ ...params, op, id });

    const antwort = await new Promise<PlayerMessage>((resolve, reject) => {
      const fail = (err: Error): void => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      };
      const timer = setTimeout(
        () => fail(new Error(`pulse-player: Zeitueberschreitung bei "${op}"`)),
        timeoutMs,
      );
      this.pending.set(id, { resolve, reject, timer });
      // **Dieselbe Luecke wie im Capture-Sidecar** (2026-08-17): mitgeschrieben
      // wurden nur die Antworten. Ein Fenster, das zugeht, sah damit gleich aus,
      // ob die App es geschlossen hat oder ob es von selbst verschwand. Die
      // Eingabe-Ops der Fernsteuerung (bis zu 125/s, s. `handleLine`) bleiben
      // draussen — die Positivliste in `sidecar-log-befehle.ts` laesst nur den
      // Lebenszyklus durch.
      const zeile = befehlZeile({ ...params, op, id });
      if (zeile) log('in', zeile);
      child.stdin.write(`${payload}\n`, (err) => {
        if (err) fail(err);
      });
    });

    // Die Sitzungsnummer vergibt der Player, sie steht erst in der Antwort.
    // Ein gescheitertes `open` kommt gar nicht bis hierher (`call` wirft dann).
    if (op === 'open' && typeof antwort.session === 'number') {
      this.leerlauf.geoeffnet(antwort.session);
    }
    return antwort;
  }

  /**
   * Startet einen Mitschnitt. Das Verzeichnis bestimmt der Hauptprozess, die
   * **Endung** der Player: AV1 muss nach Matroska, H.264 nach MPEG-TS (siehe
   * `streaming/pulse-player/src/recorder.rs`). Deshalb gewinnt der Pfad aus
   * der Antwort — der hier gebaute ist nur der Vorschlag.
   */
  async startRecording(session: number): Promise<PlayerMessage> {
    const target = recordingPath('aufnahme');
    const res = await this.call('record', { session, path: target });
    if (res.ok === false) return res;
    return { ...res, path: typeof res.path === 'string' ? res.path : target };
  }

  /** Sichert die letzten `seconds` Sekunden aus dem Ringpuffer. */
  async saveClip(session: number, seconds: number): Promise<PlayerMessage> {
    const target = recordingPath('clip');
    // Grenzen hier UND im Player — der Renderer ist nicht vertrauenswuerdig.
    const bounded = Math.min(Math.max(Number(seconds) || 30, 1), 60);
    const res = await this.call('clip', { session, path: target, seconds: bounded });
    if (res.ok === false) return res;
    return { ...res, path: typeof res.path === 'string' ? res.path : target };
  }

  /**
   * Sauber herunterfahren. Erst `shutdown` ueber das Protokoll, dann stdin
   * schliessen, dann SIGTERM, zuletzt SIGKILL.
   *
   * Wird NICHT ueber einen eigenen `before-quit`-Listener aufgerufen, sondern
   * gebuendelt mit den Capture-Sidecars im bestehenden Handler in `main.ts`
   * (`Promise.all([...allSidecars(), playerManager.shutdown()])`). Sonst liefe
   * der Player-Prozess an der dortigen Zeitbegrenzung vorbei. Bleibt damit
   * vertraeglich mit electron-updater, der an `quit` haengt, nicht an
   * `before-quit`.
   */
  async shutdown(): Promise<void> {
    // Die Frist gilt fuer einen Prozess, den es gleich nicht mehr gibt —
    // zuerst weg damit, auch im frueh zurueckspringenden Fall unten. Sonst
    // liefe sie nach einem App-Ende-Shutdown ins Leere und ein neu gestarteter
    // Player (naechstes Fenster) bekaeme ein fremdes Beenden ab.
    this.leerlauf.zuruecksetzen();
    const child = this.child;
    if (!child || child.killed) return;
    // Ab hier ist das Ende gewollt — der `exit`-Handler meldet dem Renderer
    // dann kein `failed` (s. `gewollterAbbau`).
    this.gewollterAbbau = child;
    try {
      await Promise.race([
        this.call('shutdown'),
        new Promise((r) => setTimeout(r, SHUTDOWN_GRACE_MS)),
      ]);
    } catch {
      // Egal warum das schiefging — es folgt ohnehin der harte Weg.
    }
    try {
      child.stdin.end();
    } catch {
      /* schon zu */
    }
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
      // Eskalation bis SIGKILL wie in `sidecar.ts`: ein Player, der beim
      // Beenden im GPU-Treiber haengt, darf den App-Shutdown nicht blockieren.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
          resolve();
        }, SHUTDOWN_SIGTERM_GRACE_MS);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    // Selbst aufraeumen, statt es dem `exit`-Handler zu ueberlassen: der prueft
    // seit dem 2026-08-07, ob er noch zustaendig ist, und ein spaet
    // eintreffendes `exit` findet den Verweis dann schon geleert vor.
    this.rl?.close();
    this.rl = null;
    this.child = null;
  }
}

export const playerManager = new PlayerManager();
