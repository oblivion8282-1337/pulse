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
  /** `live` | `unknown_slot` | `unresolved_source` | `masked` | `host_active`
   *  | `ended` (s. Sidecar-Op). `unknown_slot` kann auch von hier kommen, ohne
   *  dass ein Sidecar gefragt wurde — s. [`RemoteEingabe.frames`]. */
  state?: unknown;
  processed?: unknown;
}

function fehlertext(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Nur eine nicht-leere Liste aus Zeichenketten innerhalb der Wire-Grenze geht
 *  durch; sonst `null`. Der Inhalt bleibt ungeprueft — das Frame-Format kennt
 *  der Sidecar, und es an zwei Stellen zu pflegen waere genau das, was die
 *  Spezifikation dem Gateway ausdruecklich erspart.
 *
 *  Nicht zu verwechseln mit `frameListe` in `remoteInput.ts`: die SIEBT auf der
 *  Senderseite Unbrauchbares aus und schickt den Rest, hier wird die ganze
 *  Nachricht verworfen. Der Unterschied ist Absicht — eingespielt wird
 *  fail-closed, gesendet wird best-effort. */
function gepruefteFrames(wert: unknown): string[] | null {
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
  readonly #belegt: (slot: number) => boolean;

  /**
   * `maxSlots` kommt aus `sidecar.ts::MAX_STREAM_SLOTS` — hereingereicht statt
   * importiert, damit dieses Modul electron-frei bleibt.
   *
   * `belegt` beantwortet „laeuft auf diesem Platz ueberhaupt ein Sidecar?".
   * Vorgabe ist „ja" (dieses Modul kann es allein nicht wissen); `main.ts`
   * reicht die echte Auskunft herein. Warum das noetig ist, steht bei
   * [`frames`].
   */
  constructor(ruf: SidecarRuf, maxSlots: number, belegt: (slot: number) => boolean = () => true) {
    this.#ruf = ruf;
    this.#maxSlots = maxSlots;
    this.#belegt = belegt;
  }

  /**
   * Frames einspielen.
   *
   * **Ein unbrauchbarer Platz beendet die Sitzung NICHT** (Wire-Spec v2,
   * „Unbekannter Slot", praezisiert am 2026-08-12). Der Renderer laesst die
   * Sitzung bei `ok:false` fallen — ein `slot: 999` genuegte sonst, um eine
   * laufende Fernsteuerung abzuwuergen, und genau das Rennen, das die Regel
   * tolerieren soll (ein Stream endet zwischen Absenden und Ankunft), fiele
   * durch. Verworfen wird still; zurechtgebogen auf 0 wird NICHT: ein
   * verbogener Platz waere ein Klick auf dem falschen Bildschirm.
   *
   * „Unbrauchbar" heisst dabei zweierlei — ausserhalb der Schranke, ODER ohne
   * laufenden Sidecar. Das zweite ist kein Feinschliff: `#ruf` spawnt lazy,
   * also startete jede Nachricht mit einem fremden Platz einen Prozess, nur
   * damit dieser `unknown_slot` antwortet. 99 Nachrichten mit verschiedenen
   * Plaetzen waeren 99 Prozesse. `beenden()` vermeidet das seit jeher, `frames`
   * bisher nicht.
   */
  async frames(
    slot: unknown,
    sessionId: unknown,
    frames: unknown,
    hostAktiv = false,
  ): Promise<EingabeAntwort> {
    const platz = this.#platz(slot);
    // Ein Platz, der keine ganze Zahl ist, ist etwas anderes als ein
    // unbekannter: er kann aus keinem Rennen stammen, sondern nur aus einer
    // missgeformten Nachricht — und dafuer gilt fail-closed.
    if (platz === 'kaputt') return { ok: false, error: 'slot ungueltig' };
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, error: 'session_id fehlt' };
    }
    const liste = gepruefteFrames(frames);
    if (liste === null) {
      return { ok: false, error: `frames: 1..${MAX_FRAMES_PRO_NACHRICHT} Zeichenketten` };
    }
    // `null` heisst ab hier „unbekannter Platz": ausserhalb der Schranke oder
    // ohne laufenden Sidecar.
    const ziel = platz !== null && this.#belegt(platz) ? platz : null;
    try {
      // Sitzungswechsel: erst das Gedrueckte der alten freigeben, dann die neue
      // beginnen. Der Sidecar erkennt den Wechsel zwar selbst an der
      // `session_id` — aber nur in SEINEM Prozess; die anderen Plaetze der
      // alten Sitzung wuessten nichts davon.
      //
      // Das laeuft AUCH, wenn die Frames gleich verworfen werden: sonst bliebe
      // beim vorigen Gegenueber eine Taste gedrueckt, nur weil die erste
      // Nachricht der neuen Sitzung einen Platz nannte, den es nicht mehr gibt.
      // Und nur fuer LAUFENDE Sidecars — das dritte Geschwister derselben
      // Regel wie in `frames` (unbekannter Platz) und `beenden`: ein toter
      // Prozess hat nichts gedrueckt, und `#ruf` spawnt lazy.
      for (const alt of this.#wechsel(sessionId, ziel)) {
        if (this.#belegt(alt)) await this.#ruf(alt, 'remote_input_end');
      }
      if (ziel === null) return { ok: true, state: 'unknown_slot' };
      const res = (await this.#ruf(ziel, 'remote_input', {
        slot: ziel,
        session_id: sessionId,
        // Vorrang des Hosts: die Wache sitzt je Sidecar-PROZESS, und ein
        // Prozess sieht die anderen nicht. Nur der Renderer kennt alle Plaetze
        // — ohne diese Weitergabe koennte ein Steuernder auf einen Platz
        // ausweichen, dessen Wache noch gar nicht steht (Bughunt 2026-08-14,
        // Begruendung in `web/src/lib/remote/vorrang.ts`).
        host_active: hostAktiv === true,
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
      // Nur Plaetze mit LAUFENDEM Sidecar (Bughunt R2): `#ruf` spawnt lazy,
      // und ein Prozess ohne Sidecar hat auch nichts gedrueckt — endet der
      // Stream vor der Sitzung (Windows-Respawn-Modell), startete das Beenden
      // sonst einen frischen Sidecar, nur um ihm `released: 0` zu entlocken.
      // Dieselbe Zurueckhaltung, die `frames` laengst uebt.
      if (!this.#belegt(platz)) continue;
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

  /** Drei Ausgaenge, weil sie drei verschiedene Antworten verdienen: eine Zahl
   *  = brauchbarer Platz, `null` = ausserhalb der Schranke (unbekannt, still
   *  verwerfen), `'kaputt'` = keine ganze Zahl (missgeformt, fail-closed). */
  #platz(wert: unknown): number | null | 'kaputt' {
    if (typeof wert !== 'number' || !Number.isInteger(wert)) return 'kaputt';
    return wert >= 0 && wert < this.#maxSlots ? wert : null;
  }

  /** Buchfuehrung fuer `frames()`. Liefert die Plaetze, die wegen eines
   *  Sitzungswechsels vorher zu beenden sind (im Regelfall leer). `platz`
   *  `null` = die Frames werden verworfen, dann ist nichts zu merken. */
  #wechsel(sessionId: string, platz: number | null): number[] {
    let zuBeenden: number[] = [];
    if (this.#sitzung !== null && this.#sitzung !== sessionId) {
      zuBeenden = [...this.#slots];
      this.#slots.clear();
    }
    this.#sitzung = sessionId;
    if (platz !== null) this.#slots.add(platz);
    return zuBeenden;
  }
}
