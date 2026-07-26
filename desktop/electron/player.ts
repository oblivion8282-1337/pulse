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
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { app } from 'electron';

const REQUEST_TIMEOUT_MS = 10_000;
/** `open` baut eine WebRTC-Verbindung auf — das darf laenger dauern. */
const OPEN_TIMEOUT_MS = 30_000;
/** Wartezeit auf die Antwort des `shutdown`-Ops. */
const SHUTDOWN_GRACE_MS = 2_000;
/** Nach SIGTERM, bevor hart beendet wird — gleiche Staffelung wie `sidecar.ts`. */
const SHUTDOWN_SIGTERM_GRACE_MS = 2_000;

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
 *   3. Plattform-Standard im Installationsverzeichnis
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
  if (process.platform === 'linux') {
    candidates.push(`/app/bin/${BINARY_NAME}`);
  } else if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
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
  return path.join(recordingDir(), `pulse-${kind}-${stamp}.mkv`);
}

class PlayerManager {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private pending = new Map<number, PendingRequest>();
  private listeners = new Set<EventCallback>();
  private nextId = 1;
  /** Merkt einen gescheiterten Start, damit nicht bei jedem Aufruf neu probiert wird. */
  private startFailed = false;

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
      throw new Error('pulse-player nicht gefunden');
    }

    const child = spawn(binary, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on('line', (line) => this.handleLine(line));

    // Diagnose des Players geht nach stderr und gehoert ins Electron-Log,
    // nicht in den Protokollstrom.
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) console.log(`[pulse-player] ${line}`);
      }
    });

    child.on('exit', (code, signal) => {
      console.log(`[pulse-player] beendet (code=${code}, signal=${signal})`);
      this.failAllPending(new Error('pulse-player wurde beendet'));
      this.rl?.close();
      this.rl = null;
      this.child = null;
      // Laufende Sitzungen sind mit dem Prozess weg — den Renderer informieren,
      // damit er auf den Standardweg zurueckfaellt.
      this.emit({ ev: 'player:state', state: 'failed', error: 'Player-Prozess beendet' });
    });

    // EPIPE-Fehler beim Schreiben auf einen gerade gestorbenen Kindprozess
    // kommen ASYNCHRON und werden vom try/catch um `write()` nicht gefangen.
    // Ohne Listener wirft Node sie unbehandelt — und das reisst den ganzen
    // Main-Prozess mit, nicht nur den Player. `sidecar.ts` hat denselben
    // Handler aus genau diesem Grund. Nur loggen: der 'exit'-Handler und die
    // Zeitueberschreitung raeumen die offenen Anfragen bereits auf.
    child.stdin.on('error', (err) => {
      if (this.child !== child) return;
      console.error('[pulse-player] stdin-Fehler:', err);
    });

    child.on('error', (err) => {
      console.error('[pulse-player] Start fehlgeschlagen:', err);
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
      console.warn(`[pulse-player] unlesbare Zeile: ${trimmed.slice(0, 200)}`);
      return;
    }

    // Ereignis (`ev`) statt Antwort (`id`/`ok`) — gleiche Unterscheidung wie
    // bei den Capture-Sidecars.
    if (typeof msg.ev === 'string') {
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
        console.error('[pulse-player] Ereignis-Empfaenger warf:', err);
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
    const child = this.ensureStarted();
    const id = this.nextId;
    this.nextId += 1;

    const timeoutMs = op === 'open' ? OPEN_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
    const payload = JSON.stringify({ ...params, op, id });

    return new Promise<PlayerMessage>((resolve, reject) => {
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
      child.stdin.write(`${payload}\n`, (err) => {
        if (err) fail(err);
      });
    });
  }

  /** Startet einen Mitschnitt; der Zielpfad wird hier bestimmt, nicht drueben. */
  async startRecording(session: number): Promise<PlayerMessage> {
    const target = recordingPath('aufnahme');
    const res = await this.call('record', { session, path: target });
    return res.ok === false ? res : { ...res, path: target };
  }

  /** Sichert die letzten `seconds` Sekunden aus dem Ringpuffer. */
  async saveClip(session: number, seconds: number): Promise<PlayerMessage> {
    const target = recordingPath('clip');
    // Grenzen hier UND im Player — der Renderer ist nicht vertrauenswuerdig.
    const bounded = Math.min(Math.max(Number(seconds) || 30, 1), 60);
    const res = await this.call('clip', { session, path: target, seconds: bounded });
    return res.ok === false ? res : { ...res, path: target };
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
    const child = this.child;
    if (!child || child.killed) return;
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
    this.child = null;
  }
}

export const playerManager = new PlayerManager();
