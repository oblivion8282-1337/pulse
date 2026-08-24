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
import type { SchirmStandFuerFenster } from '$lib/devices/schirme.svelte';
import type { Zeigerbild, Zeigerform } from './zeigerform';

function player() {
  return typeof window !== 'undefined' ? window.pulse?.player : undefined;
}

function input() {
  return player()?.input;
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
 * Den Anzeigetext des Eingabewegs ins Statistik-Feld des Player-Fensters
 * melden („Direktverbindung" / „Serverweg — …"). Best-effort: die Anzeige ist
 * Diagnose, kein Betriebsteil — ein Wurf (Fenster gerade zu) darf den
 * Eingabefluss nicht beruehren.
 */
export async function transportMelden(fensterSitzung: number, transport: string): Promise<void> {
  try {
    await player()?.transportStatus?.(fensterSitzung, transport);
  } catch (e) {
    console.warn('[remote] Transport-Anzeige warf:', e);
  }
}

/**
 * Die Form des Host-Zeigers ins Player-Fenster melden („text", „ns-resize" …).
 * Der Player setzt sie auf den lokalen Zeiger des Steuernden — das ersetzt,
 * was das Cursor-Echo aus dem Bild nimmt (`$lib/remote/zeigerform.ts`).
 *
 * `bild` kommt fuer Zeiger mit, die kein Name traegt (Werkzeugzeiger von
 * Schnitt-, Bild- und 3D-Programmen). Der Player nimmt es, wenn er es bauen
 * kann, und faellt sonst auf `form` zurueck — deshalb geht die Form **immer**
 * mit, auch wenn ein Bild dabei ist.
 *
 * `imBild` ist der Rueckfall: kann der Host die Form gar nicht mehr melden,
 * legt er seinen Zeiger zurueck ins Videobild, und der Player blendet dann
 * seinen lokalen aus — sonst waeren zwei zu sehen, und der falsche waere der
 * schnellere (`$lib/remote/zeigerImBild.ts`).
 *
 * Best-effort wie die Transport-Anzeige: eine ausgebliebene Form kostet
 * Rueckmeldung, keine Eingabe, und darf den Fluss nicht beruehren.
 */
export async function zeigerformMelden(
  fensterSitzung: number,
  form: Zeigerform,
  bild?: Zeigerbild,
  imBild?: boolean,
): Promise<void> {
  try {
    await player()?.pointerShape?.(fensterSitzung, form, bild, imBild);
  } catch (e) {
    console.warn('[remote] Zeigerform warf:', e);
  }
}

/**
 * Die Bildschirme des fernen Rechners ins Player-Fenster melden — fuers Menue
 * am Griff (`overlay/fernbedienung.rs`).
 *
 * **Die Liste ist je Fenster verschieden** (Teil 3 der Bildschirm-Karte): der
 * Aufrufer meldet fuer JEDES Fenster seine eigene, mit `dieses_fenster` auf
 * genau dem Bildschirm, den DIESES Fenster gerade zeigt
 * (`devices/schirme.svelte.ts::schirmeVonFuerFenster`) — fail-visible auf
 * `false` ueberall, wenn die Zuordnung nicht eindeutig ist.
 *
 * Die Form ist **`SchirmStandFuerFenster` selbst**, nicht von Hand
 * nachgeschrieben (Befund der Schlusspruefung 2026-08-25): eine ausgeschriebene
 * Kopie war die sechste im Baum und bereits auseinandergelaufen — ihr fehlte
 * `primary`, das der Aufrufer per `{...s}` trotzdem mitschickt. Ein reiner
 * Typ-Import, also kein Laufzeit-Ring zwischen `remote/` und `devices/`.
 * `x`/`y`/`width`/`height` sind Lage und Groesse in Bildpunkten auf dem fernen
 * Rechner, alle optional: eine aeltere Gegenstelle (App ODER Geraet) meldet
 * sie nicht.
 *
 * Best-effort wie die Transport-Anzeige: eine ausgebliebene Liste kostet einen
 * Menuepunkt, keine Eingabe. Eine aeltere Shell kennt den Op nicht; dann bleibt
 * das Menue schlicht ohne Bildschirme.
 */
export async function bildschirmeMelden(
  fensterSitzung: number,
  schirme: SchirmStandFuerFenster[],
): Promise<void> {
  try {
    await player()?.screens?.(fensterSitzung, schirme);
  } catch (e) {
    console.warn('[remote] Bildschirmliste warf:', e);
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
