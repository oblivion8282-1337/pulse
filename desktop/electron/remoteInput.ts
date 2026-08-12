/**
 * Fernsteuerung — der Weg der Eingabe-Frames vom Player zum Gateway.
 *
 * Der native Player (`streaming/pulse-player/src/fernsteuerung/`) erfasst Maus
 * und Tastatur, kodiert sie nach der Wire-Spec
 * (`docs/plans/2026-08-12-input-wire-protokoll-v2.md`) und meldet die Frames als
 * `player:input`-Ereignis ueber stdio herauf. Hier werden daraus die
 * `remote_input`-Nachrichten der Huelle gebaut:
 *
 *     { op: "remote_input", session_id, slot, frames: [base64, ...] }
 *
 * **Gesendet wird im RENDERER, nicht hier.** Der Hauptprozess hat keine
 * WebSocket zum Gateway — die App-Verbindung samt Token, Reconnect und
 * Sitzungszustand lebt vollstaendig im Renderer (die Web-App wird remote
 * geladen). Eine zweite Verbindung von hier aus bedeutete: ein zweites
 * Token-Handling, ein zweiter Reconnect und eine zweite Stelle, an der eine
 * Sitzung fuer beendet gehalten werden kann. Der Hauptprozess buendelt deshalb
 * nur und reicht die fertigen Nachrichten ueber `player:remoteInput` an den
 * Renderer weiter, der sie auf seiner bestehenden Verbindung absetzt.
 *
 * **Warum das Buendeln trotzdem hier passiert und nicht im Renderer:** die
 * Zuordnung Player-Sitzung -> Fernsteuerungs-Sitzung entsteht beim Einschalten
 * der Erfassung, und das laeuft ohnehin ueber den Hauptprozess (er spricht mit
 * dem Player). Wer die Zuordnung dort haelt, wo sie entsteht, kann keine Frames
 * an die falsche Sitzung schicken.
 */

/** Grenze der Wire-Spec: hoechstens so viele Frames je Nachricht. Der Gateway
 *  erzwingt sie und verwirft darueber mit Fehler 4050. */
export const MAX_FRAMES_PRO_NACHRICHT = 32;

/** Die Huelle auf dem Serverweg. */
export interface RemoteInputNachricht {
  op: 'remote_input';
  session_id: string;
  /** Welcher der gleichzeitig laufenden Streams des Hosts gemeint ist. */
  slot: number;
  frames: string[];
}

/** Was der Hauptprozess sich je Player-Sitzung merkt. */
interface Zuordnung {
  sessionId: string;
  slot: number;
}

/**
 * Nachlauf beim Abschalten der Erfassung: so lange bleibt die Zuordnung noch
 * stehen.
 *
 * Der Player reicht nach dem Abschalten noch die Hoch-Ereignisse fuer alles
 * Gedrueckte nach. Wer sofort abmeldet, verwirft genau die — und beim Host
 * klemmt die Taste.
 */
const ABMELDE_NACHLAUF_MS = 1_000;

/**
 * Frames in Nachrichten zu hoechstens [`MAX_FRAMES_PRO_NACHRICHT`] aufteilen.
 *
 * Die Reihenfolge bleibt erhalten — sie ist bedeutungstragend: ein Klick, der
 * seine Positionierung ueberholt, landet am falschen Ort.
 */
export function buendeln(
  sessionId: string,
  slot: number,
  frames: readonly string[],
): RemoteInputNachricht[] {
  const nachrichten: RemoteInputNachricht[] = [];
  for (let i = 0; i < frames.length; i += MAX_FRAMES_PRO_NACHRICHT) {
    nachrichten.push({
      op: 'remote_input',
      session_id: sessionId,
      slot,
      frames: frames.slice(i, i + MAX_FRAMES_PRO_NACHRICHT),
    });
  }
  return nachrichten;
}

/** Nur Strings durchlassen — was der Player schickt, geht ungeprueft weiter an
 *  den Gateway, und der reicht es ungeprueft an den Host. */
function frameListe(wert: unknown): string[] {
  if (!Array.isArray(wert)) return [];
  return wert.filter((f): f is string => typeof f === 'string' && f.length > 0);
}

/**
 * Haelt die Zuordnung Player-Sitzung -> Fernsteuerungs-Sitzung und formt aus
 * `player:input`-Ereignissen die fertigen Nachrichten.
 *
 * Rein und ohne Electron-Abhaengigkeit, damit sie ohne laufende App pruefbar
 * ist (`desktop/test/remoteInput.test.ts`).
 */
export class EingabeWeiche {
  private zuordnungen = new Map<number, Zuordnung>();
  /** Laufende Nachlauf-Fristen je Player-Sitzung (s. `abmeldenVerzoegert`). */
  private nachlauf = new Map<number, ReturnType<typeof setTimeout>>();

  /** Erfassung fuer eine Player-Sitzung anmelden. `slot` gilt ab sofort. */
  anmelden(playerSession: number, sessionId: string, slot: number): void {
    // Eine noch laufende Nachlauf-Frist galt der ALTEN Zuordnung — sie muss
    // hier weg. Sonst loescht sie kurz darauf die eben gesetzte neue, und ab da
    // fliesst still gar keine Eingabe mehr. Der Effect der steuernden Seite
    // macht bei jeder Aenderung von Sitzung oder Platz genau diese Abfolge:
    // erst aus (mit Nachlauf), sofort danach wieder an.
    this.nachlaufAbraeumen(playerSession);
    this.zuordnungen.set(playerSession, { sessionId, slot });
  }

  abmelden(playerSession: number): void {
    this.nachlaufAbraeumen(playerSession);
    this.zuordnungen.delete(playerSession);
  }

  /**
   * Abmelden mit Nachlauf (s. [`ABMELDE_NACHLAUF_MS`]) — der Weg beim
   * Abschalten der Erfassung. Eine neue [`anmelden`] fuer dieselbe
   * Player-Sitzung raeumt die Frist ab.
   */
  abmeldenVerzoegert(playerSession: number, ms = ABMELDE_NACHLAUF_MS): void {
    this.nachlaufAbraeumen(playerSession);
    const frist = setTimeout(() => {
      this.nachlauf.delete(playerSession);
      this.zuordnungen.delete(playerSession);
    }, ms);
    // Der Nachlauf darf das Beenden der App nicht aufhalten.
    frist.unref?.();
    this.nachlauf.set(playerSession, frist);
  }

  /**
   * Alles vergessen — fuer den Fall, dass die Gegenstelle im Renderer
   * verschwindet (Neuladen, abgestuerzter Renderer). Die Zuordnungen zeigen
   * dann auf Fernsteuerungs-Sitzungen, die es nicht mehr gibt; Frames darauf
   * wuerde der Gateway ohnehin mit 4053 abweisen.
   */
  alleAbmelden(): void {
    for (const frist of this.nachlauf.values()) clearTimeout(frist);
    this.nachlauf.clear();
    this.zuordnungen.clear();
  }

  /** Fuer Tests und den Abbau: welche Sitzungen noch angemeldet sind. */
  angemeldet(): number[] {
    return [...this.zuordnungen.keys()];
  }

  private nachlaufAbraeumen(playerSession: number): void {
    const frist = this.nachlauf.get(playerSession);
    if (frist !== undefined) {
      clearTimeout(frist);
      this.nachlauf.delete(playerSession);
    }
  }

  /**
   * Ein `player:input`-Ereignis in Nachrichten uebersetzen.
   *
   * Leeres Ergebnis heisst „nichts zu senden" — auch bei einer unbekannten
   * Sitzung. Das ist Absicht: die Erfassung kann im Player noch ein paar Frames
   * nachreichen (die Hoch-Ereignisse beim Abschalten), nachdem hier schon
   * abgemeldet wurde. Ein Fehler waere das nicht, ein Rennen ist es.
   */
  verteilen(ev: Record<string, unknown>): RemoteInputNachricht[] {
    const playerSession = typeof ev.session === 'number' ? ev.session : null;
    if (playerSession === null) return [];
    const zuordnung = this.zuordnungen.get(playerSession);
    if (!zuordnung) return [];
    const frames = frameListe(ev.frames);
    if (frames.length === 0) return [];
    // **Sitzung und Platz sind ein Paar.** Beide stammen aus DEMSELBEN
    // `input_capture`; sie zu trennen hiesse, Frames mit der Kennung der einen
    // Steuerung an den Bildschirm einer anderen zu schicken.
    //
    // Hier gewann bis zum 2026-08-12 der Platz aus dem Ereignis. Das klang nach
    // „frischere Quelle" und war eine Falle: kam von unten eine 0 (ein
    // Vorgabewert statt eines echten Platzes), gingen die Frames an Platz 0 —
    // einen fremden, laufenden Stream, dessen Sidecar nie ein Hello gesehen
    // hatte und der deshalb fail-closed stehenblieb.
    //
    // Weicht der Platz ab, wird deshalb weder das eine noch das andere
    // genommen, sondern gar nichts: die Frames gehoeren zu einer Erfassung, die
    // diese Zuordnung nicht beschreibt. Verworfen wird still, wie bei einer
    // unbekannten Sitzung — es ist dasselbe Rennen und kein Angriff.
    if (typeof ev.slot === 'number' && ev.slot !== zuordnung.slot) return [];
    return buendeln(zuordnung.sessionId, zuordnung.slot, frames);
  }
}

/** Was der Renderer beim Schalten der Erfassung angibt. */
export interface Schaltauftrag {
  /** Sitzung des Player-FENSTERS (nicht die der Fernsteuerung). */
  session: number;
  enabled: boolean;
  /** Die per Consent bestaetigte Fernsteuerungs-Sitzung. Nur beim Einschalten
   *  von Belang — beim Ausschalten gilt die angemeldete weiter. */
  sessionId: string;
  /** Welcher der gleichzeitig laufenden Streams des Hosts gemeint ist. */
  slot: number;
  pointerLock: boolean;
}

export type AuftragErgebnis =
  | { ok: true; auftrag: Schaltauftrag }
  | { ok: false; error: string };

/**
 * Die Argumente aus dem Renderer pruefen.
 *
 * **Ein ungueltiger Platz wird abgewiesen, nicht zurechtgebogen.** Ein
 * verbogener Platz waere ein Klick auf dem falschen Bildschirm; fehlt die
 * Angabe ganz, gilt Platz 0 — so steht „erster Stream" in der Wire-Spec, und
 * das ist eine Vorgabe, keine Korrektur.
 */
export function auftragLesen(args: unknown): AuftragErgebnis {
  const a = (args ?? {}) as Record<string, unknown>;
  if (typeof a.session !== 'number') return { ok: false, error: 'session fehlt' };
  const enabled = a.enabled === true;
  const sessionId = typeof a.sessionId === 'string' ? a.sessionId : '';
  // Ohne Sitzungskennung gaebe es kein Ziel — dann lieber gar nicht erfassen,
  // als Eingaben zu erzeugen, die nirgends ankommen.
  if (enabled && !sessionId) return { ok: false, error: 'sessionId fehlt' };
  if (a.slot !== undefined && (!Number.isInteger(a.slot) || (a.slot as number) < 0)) {
    return { ok: false, error: 'slot ungueltig' };
  }
  return {
    ok: true,
    auftrag: {
      session: a.session,
      enabled,
      sessionId,
      slot: a.slot === undefined ? 0 : (a.slot as number),
      pointerLock: a.pointerLock === true,
    },
  };
}

/**
 * Erfassung im Player schalten und die Zuordnung dazu fuehren.
 *
 * **Die Zuordnung entsteht VOR dem Aufruf** — das ist der ganze Punkt dieser
 * Funktion. Der Player schreibt die Antwort auf `input_capture` und das erste
 * `player:input` (mit dem Hello darin) im selben Schleifendurchlauf in dieselbe
 * Pipe; `readline` arbeitet alle Zeilen eines Chunks **synchron** ab, waehrend
 * die Fortsetzung hinter einem `await` nur ein Microtask ist und erst danach
 * laeuft. Wer sich erst nach dem `await` anmeldet, verwirft damit
 * zuverlaessig das Hello des ersten Einschaltens — die naechste Abgabe ist dann
 * eine Bewegung, und der Host geht fail-closed („Eingabe vor dem
 * Hello-Handschlag"). Betroffen war jedes erste Einschalten je Player-Fenster.
 *
 * Scheitert der Aufruf, wird die Zuordnung wieder abgemeldet: dann erfasst der
 * Player nicht, und was hier noch stuende, zeigte auf eine Erfassung, die es
 * nicht gibt.
 */
export async function erfassungSchalten(
  weiche: EingabeWeiche,
  ruf: (params: Record<string, unknown>) => Promise<Record<string, unknown>>,
  auftrag: Schaltauftrag,
): Promise<Record<string, unknown>> {
  const { session, enabled, sessionId, slot, pointerLock } = auftrag;
  if (enabled) weiche.anmelden(session, sessionId, slot);
  try {
    // **Beim Ausschalten geht kein Platz mit.** Die Hoch-Ereignisse fuer alles
    // Gedrueckte gehoeren dem Stream, der gerade gesteuert wurde; nur der
    // Player weiss, welcher das ist, und er behaelt ihn ueber das Ausschalten
    // hinweg (`Erfassung::ausschalten`). Ein Feld, das hier mitginge, koennte
    // nur falsch sein — `stop()` kennt den Platz nicht.
    const res = enabled
      ? await ruf({
          session,
          enabled: true,
          slot,
          pointer_lock: pointerLock,
          // Der Player deutet die Kennung nicht; er vergleicht sie nur mit der
          // vorigen. Daran entscheidet sich, ob liegengebliebene
          // Hoch-Ereignisse des alten Stroms noch an dasselbe Ziel gehen.
          remote_session: sessionId,
        })
      : await ruf({ session, enabled: false });
    if (enabled && res.ok === false) {
      weiche.abmelden(session);
      return res;
    }
    // Beim Abschalten NICHT sofort abmelden: der Player reicht danach noch die
    // Hoch-Ereignisse fuer alles Gedrueckte nach, und die duerfen nicht an der
    // Weiche haengenbleiben — sonst klemmt beim Host eine Taste. Der Nachlauf
    // gehoert in die Weiche, nicht in ein freies `setTimeout`: nur dort kann
    // ihn ein spaeteres `anmelden` wieder abraeumen (s. dort).
    if (!enabled) weiche.abmeldenVerzoegert(session);
    return res;
  } catch (e) {
    if (enabled) weiche.abmelden(session);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
