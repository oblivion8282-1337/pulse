/**
 * Fernsteuerung, HOST-Seite — der Weg vom Renderer in den Windows-Sidecar.
 *
 * Gegenstueck zu `remoteInput.ts`, das dieselbe Strecke fuer den Steuernden
 * beschreibt. Hier laeuft sie andersherum: der Host bekommt `remote_input` auf
 * SEINER App-WebSocket, und die lebt vollstaendig im Renderer (der
 * Hauptprozess hat keine Verbindung zum Gateway und soll keine bekommen —
 * Begruendung in `remoteInput.ts`). Der Injektor sitzt dagegen im Sidecar, und
 * der haengt am Hauptprozess. Dieses Stueck ist das Scharnier dazwischen.
 *
 * **Warum hier ueberhaupt etwas gemerkt wird.** Windows faehrt je Stream-Platz
 * einen eigenen Sidecar-Prozess (`sidecar.ts::getSidecar(slot)`), und die
 * Eingabe-Sitzung ist in jedem davon ein Singleton
 * (`streaming/win-hq-sidecar/src/ops/remote_input.rs`). „Alles loslassen beim
 * Ende" (Wire-Spec, Abschnitt „Sicherheit und Robustheit") muss deshalb genau
 * die Prozesse erreichen, die wirklich Frames gesehen haben:
 *
 *   - alle Plaetze anzusprechen hiesse, Sidecar-Prozesse zu STARTEN, nur um
 *     ihnen zu sagen, dass sie nichts zu tun haben (`call()` spawnt lazy),
 *   - nur den zuletzt benutzten Platz anzusprechen liesse bei einem
 *     Platz-Wechsel mitten in der Sitzung auf dem vorherigen Bildschirm eine
 *     Taste gedrueckt stehen.
 *
 * Ohne Electron-Abhaengigkeit, damit es ohne laufende App pruefbar ist
 * (`desktop/test/remoteInputHost.test.ts`) — die Anbindung an `ipcMain` und
 * `getSidecar()` macht `main.ts`.
 */

// Mit `.ts`-Endung wie in `localBackend/`: die Node-Unit-Tests laufen ohne
// Bundler direkt auf den Quellen und brauchen den vollen Dateinamen.
import { MAX_FRAMES_PRO_NACHRICHT } from './remoteInput.ts';

/** Eine Op auf dem Sidecar EINES Stream-Platzes ausfuehren. Wirft, wenn der
 *  Sidecar fehlt, stirbt oder mit `ok:false` antwortet. */
export type SidecarRuf = (slot: number, op: string, params?: unknown) => Promise<unknown>;

/** Was ueber die Bruecke zurueck in den Renderer geht. Immer ein Umschlag, nie
 *  eine geworfene Ausnahme — der Renderer entscheidet an `ok`, ob er die
 *  Sitzung fallen laesst (fail-closed). */
export interface EingabeAntwort {
  ok: boolean;
  error?: string;
  /** `live` | `unknown_slot` | `unresolved_source` | `masked` (s. Sidecar-Op). */
  state?: unknown;
  processed?: unknown;
}

function fehlertext(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Nur eine nicht-leere Liste aus Zeichenketten innerhalb der Wire-Grenze geht
 *  durch; sonst `null`. Der Inhalt bleibt ungeprueft — das Frame-Format kennt
 *  der Sidecar, und es an zwei Stellen zu pflegen waere genau das, was die
 *  Spezifikation dem Gateway ausdruecklich erspart. */
function frameListe(wert: unknown): string[] | null {
  if (!Array.isArray(wert) || wert.length === 0) return null;
  if (wert.length > MAX_FRAMES_PRO_NACHRICHT) return null;
  if (!wert.every((f) => typeof f === 'string' && f.length > 0)) return null;
  return wert as string[];
}

export class RemoteEingabe {
  /** Plaetze, deren Sidecar in DIESER Sitzung schon Frames gesehen hat. */
  readonly #slots = new Set<number>();
  #sitzung: string | null = null;
  readonly #ruf: SidecarRuf;
  readonly #maxSlots: number;

  /** `maxSlots` kommt aus `sidecar.ts::MAX_STREAM_SLOTS` — hereingereicht statt
   *  importiert, damit dieses Modul electron-frei bleibt. */
  constructor(ruf: SidecarRuf, maxSlots: number) {
    this.#ruf = ruf;
    this.#maxSlots = maxSlots;
  }

  /**
   * Frames einspielen.
   *
   * Ein Platz ausserhalb der Schranke wird ABGEWIESEN und nicht auf 0
   * zurechtgebogen: ein verbogener Platz waere ein Klick auf dem falschen
   * Bildschirm, ein abgewiesener ist nur ein verlorener Klick.
   */
  async frames(slot: unknown, sessionId: unknown, frames: unknown): Promise<EingabeAntwort> {
    const platz = this.#platz(slot);
    if (platz === null) return { ok: false, error: 'slot ungueltig' };
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, error: 'session_id fehlt' };
    }
    const liste = frameListe(frames);
    if (liste === null) {
      return { ok: false, error: `frames: 1..${MAX_FRAMES_PRO_NACHRICHT} Zeichenketten` };
    }
    try {
      // Sitzungswechsel: erst das Gedrueckte der alten freigeben, dann die neue
      // beginnen. Der Sidecar erkennt den Wechsel zwar selbst an der
      // `session_id` — aber nur in SEINEM Prozess; die anderen Plaetze der
      // alten Sitzung wuessten nichts davon.
      for (const alt of this.#wechsel(sessionId, platz)) {
        await this.#ruf(alt, 'remote_input_end');
      }
      const res = (await this.#ruf(platz, 'remote_input', {
        slot: platz,
        session_id: sessionId,
        frames: liste,
      })) as Record<string, unknown> | undefined;
      return { ok: true, state: res?.state, processed: res?.processed };
    } catch (e) {
      return { ok: false, error: fehlertext(e) };
    }
  }

  /**
   * Sitzungsende — „alles loslassen" an jeden Platz, der Frames gesehen hat.
   *
   * Idempotent, und ohne Frames zuvor folgenlos: dann ist die Menge leer und es
   * wird kein einziger Sidecar angefasst (und damit auch keiner gestartet).
   */
  async beenden(): Promise<EingabeAntwort> {
    const plaetze = [...this.#slots];
    this.#slots.clear();
    this.#sitzung = null;
    let fehler: string | undefined;
    for (const platz of plaetze) {
      // Jeder Platz wird versucht, auch wenn ein frueherer scheiterte: eine
      // haengende Taste auf Bildschirm 2 waere kein Grund, sie auf Bildschirm 1
      // ebenfalls haengen zu lassen.
      try {
        await this.#ruf(platz, 'remote_input_end');
      } catch (e) {
        fehler ??= fehlertext(e);
      }
    }
    return fehler ? { ok: false, error: fehler } : { ok: true };
  }

  /** Fuer Tests und Diagnose: welche Plaetze gerade eine Eingabe-Sitzung haben. */
  offen(): number[] {
    return [...this.#slots];
  }

  /** Die Fernsteuerungs-Sitzung, deren Frames zuletzt ankamen (`null` = keine). */
  get sitzung(): string | null {
    return this.#sitzung;
  }

  #platz(wert: unknown): number | null {
    if (typeof wert !== 'number' || !Number.isInteger(wert)) return null;
    return wert >= 0 && wert < this.#maxSlots ? wert : null;
  }

  /** Buchfuehrung fuer `frames()`. Liefert die Plaetze, die wegen eines
   *  Sitzungswechsels vorher zu beenden sind (im Regelfall leer). */
  #wechsel(sessionId: string, platz: number): number[] {
    let zuBeenden: number[] = [];
    if (this.#sitzung !== null && this.#sitzung !== sessionId) {
      zuBeenden = [...this.#slots];
      this.#slots.clear();
    }
    this.#sitzung = sessionId;
    this.#slots.add(platz);
    return zuBeenden;
  }
}
