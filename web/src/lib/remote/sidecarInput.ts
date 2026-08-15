/**
 * Fernsteuerung, HOST-Seite — Renderer zum Sidecar.
 *
 * Der Host empfaengt `remote_input` auf der App-WebSocket, und die lebt hier im
 * Renderer. Der Injektor sitzt im Sidecar, und der haengt am
 * Electron-Hauptprozess. Diese Datei ist die Renderer-Haelfte der Bruecke
 * dazwischen; die andere Haelfte ist `desktop/electron/remoteInputHost.ts`.
 *
 * Wie `$lib/player/client.ts` gebaut: im Browser und in aelteren Shells liefert
 * jede Funktion still ein Ergebnis statt zu werfen. Der Unterschied ist die
 * BEDEUTUNG dieses Ergebnisses — `false` heisst hier „diese Eingabe kam nicht
 * an", und der Aufrufer laesst die Sitzung daraufhin fallen. Eine
 * Fernsteuerung, die nur die Haelfte der Tastendruecke zustellt, ist
 * gefaehrlicher als gar keine.
 */

/** Die Bruecke, oder `undefined` im Browser / in einer Shell ohne sie. */
function gsr() {
  return typeof window !== 'undefined' ? window.pulse?.gsr : undefined;
}

/**
 * Ereignisse des Sidecars abonnieren (`remote_state`, `remote_pointer` …).
 * Liefert den Abmelder, oder `null`, wenn es die Bruecke nicht gibt — im
 * Browser und in einer aelteren Shell bleibt es dann still, wie ueberall in
 * dieser Datei.
 *
 * Zwei Module hoeren mit, beide nur in der Host-Rolle: `vorrang.ts` und
 * `zeigerform.ts`. Die Weiche nach Rolle steht dort, die Bruecken-Pruefung
 * hier — sie ist an beiden Stellen dieselbe.
 */
export function aufSidecarEreignisse(cb: (ev: unknown) => void): (() => void) | null {
  const bruecke = gsr();
  if (typeof bruecke?.onEvent !== 'function') return null;
  return bruecke.onEvent(cb);
}

/** Kann dieser Rechner ueberhaupt ferngesteuert werden? Nur eine Pruefung der
 *  Bruecke — ob ein Stream laeuft und der Sidecar den Platz kennt, entscheidet
 *  der Sidecar zur Injektionszeit. */
export function eingabeMoeglich(): boolean {
  return typeof gsr()?.remoteInput === 'function';
}

/**
 * Frames einspielen. `true` = angekommen, `false` = **fail-closed**: der
 * Sidecar hat die Eingabe-Sitzung stillgelegt (Protokollfehler), oder es gibt
 * gar keine Bruecke. Der Aufrufer beendet die Fernsteuerungs-Sitzung.
 *
 * `hostAktiv` sagt, dass ein ANDERER Stream-Platz gerade Vorrang des Hosts
 * meldet — die Wache sitzt je Sidecar-Prozess, und nur der Renderer kennt alle
 * Plaetze (Begruendung in `vorrang.ts`). Die Frames werden dann auch auf dem
 * angesprochenen Platz verworfen, aber ueber den regulaeren Verwerf-Pfad: der
 * Handschlag ueberlebt, alles Gedrueckte geht hoch.
 *
 * Ein unbekannter Platz oder ein aktiver Sichtschutz sind ausdruecklich KEIN
 * Fehlschlag: die Frames werden dann still verworfen und die Sitzung bleibt
 * stehen (Spezifikation, „Unbekannter Slot"). „Unbekannt" schliesst einen Platz
 * ausserhalb der Schranke ein — den beantwortet schon die Bruecke so
 * (`remoteInputHost.ts`), ohne dafuer einen Sidecar zu starten.
 */
export async function eingabeEinspielen(
  slot: number,
  sessionId: string,
  frames: string[],
  hostAktiv = false,
): Promise<boolean> {
  const bruecke = gsr();
  if (typeof bruecke?.remoteInput !== 'function') return false;
  try {
    const res = (await bruecke.remoteInput(slot, sessionId, frames, hostAktiv)) as
      | { ok?: unknown; error?: unknown }
      | undefined;
    if (res?.ok === false) {
      console.warn('[remote] Eingabe abgewiesen:', res.error);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[remote] Eingabe warf:', e);
    return false;
  }
}

/**
 * Sitzungsende — der Sidecar gibt alles Gedrueckte frei.
 *
 * **Der wichtigste Ruf dieser Datei.** Ohne ihn laeuft nach einem Abbruch die
 * W-Taste im Spiel weiter. Er gehoert deshalb an JEDES Ende: regulaeres
 * Beenden, Ablehnung, Gegenueber weg, Verbindungsverlust. Idempotent und ohne
 * vorherige Frames folgenlos — man darf ihn lieber einmal zu oft rufen.
 */
export async function eingabeFreigeben(): Promise<void> {
  const bruecke = gsr();
  if (typeof bruecke?.remoteInputEnd !== 'function') return;
  try {
    await bruecke.remoteInputEnd();
  } catch (e) {
    console.warn('[remote] Freigabe warf:', e);
  }
}
