/**
 * Fernsteuerung, STEUERNDE Seite — Player-Fenster zum Renderer.
 *
 * Der native Player (`streaming/pulse-player/`) erfasst Maus und Tastatur,
 * Electron buendelt sie zu fertigen `remote_input`-Nachrichten
 * (`desktop/electron/remoteInput.ts`) und schiebt sie hier herueber. Abgesetzt
 * werden sie im Renderer, weil nur der eine WebSocket zum Gateway hat.
 *
 * Erfasst wird ausschliesslich IM Player-Fenster — dort, wo der Steuernde das
 * Bild des Hosts sieht. Ein Tastendruck in der App selbst geht die
 * Fernsteuerung nichts an.
 */

import type { PulseRemoteInputNachricht } from '$lib/platform/pulse.d';

function input() {
  return typeof window !== 'undefined' ? window.pulse?.player?.input : undefined;
}

/** Steht die Eingabe-Erfassung zur Verfuegung (Electron + Player-Binary +
 *  aktuelle Shell)? */
export function erfassungMoeglich(): boolean {
  return input() !== undefined;
}

/**
 * Erfassung im Fenster `fensterSitzung` einschalten. `sessionId` ist die per
 * Consent bestaetigte Fernsteuerungs-Sitzung, `slot` der gemeinte Stream des
 * Hosts. `false`, wenn es nicht geklappt hat — dann fliesst nichts, und der
 * Aufrufer sollte die Sitzung gar nicht erst laufen lassen.
 */
export async function erfassungAn(
  fensterSitzung: number,
  sessionId: string,
  slot: number,
): Promise<boolean> {
  const api = input();
  if (!api) return false;
  try {
    const res = (await api.start(fensterSitzung, sessionId, slot)) as { ok?: unknown } | undefined;
    return res?.ok !== false;
  } catch (e) {
    console.warn('[remote] Erfassung an warf:', e);
    return false;
  }
}

/**
 * Erfassung ausschalten. Der Player reicht danach fuer alles Gedrueckte noch
 * das Hoch-Ereignis nach — die kommen ueber [`aufNachrichten`] und muessen noch
 * abgesetzt werden, sonst klemmt beim Host eine Taste.
 */
export async function erfassungAus(fensterSitzung: number): Promise<void> {
  try {
    await input()?.stop(fensterSitzung);
  } catch (e) {
    console.warn('[remote] Erfassung aus warf:', e);
  }
}

/** Fertige `remote_input`-Nachrichten abonnieren. Liefert eine
 *  Abmelde-Funktion (im Browser eine leere). */
export function aufNachrichten(cb: (n: PulseRemoteInputNachricht) => void): () => void {
  const api = input();
  if (!api) return () => {};
  return api.onFrames((n) => {
    // IPC-Nutzlast ist per Konvention ungeprueft — der Absender ist zwar der
    // eigene Hauptprozess, aber die Form hier zu pruefen kostet nichts und
    // haelt einen halb aktualisierten Client vom Gateway fern.
    if (!n || typeof n !== 'object') return;
    const m = n as Partial<PulseRemoteInputNachricht>;
    if (typeof m.session_id !== 'string' || typeof m.slot !== 'number') return;
    if (!Array.isArray(m.frames) || m.frames.length === 0) return;
    cb({ op: 'remote_input', session_id: m.session_id, slot: m.slot, frames: m.frames });
  });
}
