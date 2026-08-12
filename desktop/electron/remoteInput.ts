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
    // Der Slot aus dem Ereignis gewinnt: der Player kennt ihn aus demselben
    // `input_capture`, das hier die Zuordnung angelegt hat, und ist damit die
    // frischere Quelle, falls beides auseinanderlaeuft.
    const slot = typeof ev.slot === 'number' ? ev.slot : zuordnung.slot;
    return buendeln(zuordnung.sessionId, slot, frames);
  }
}
