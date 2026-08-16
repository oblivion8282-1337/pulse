/**
 * Renderer-Seite des nativen HQ-Players.
 *
 * Der Player ist ein **Zusatz**, kein Ersatz: er existiert nur unter Electron
 * und auch dort nur, wenn das Binary mitinstalliert ist. Im Browser und
 * ueberall sonst bleibt der bestehende Weg (`WhepPlayer.svelte` mit
 * `<video>`) unveraendert. Jede Funktion hier ist so gebaut, dass sie im
 * Browser still `false`/`null` liefert statt zu werfen.
 *
 * Warum es ihn gibt: `streaming/pulse-player/README.md`.
 */

import { isElectron } from '$lib/platform/runtime';
import type { PulsePlayerOptions, PulsePlayerResult } from '$lib/platform/pulse.d';

/** Zustand einer Wiedergabe-Sitzung, wie ihn der Player meldet. */
export type PlayerState = 'connecting' | 'playing' | 'stalled' | 'closed' | 'failed';

export interface PlayerStateEvent {
  ev: 'player:state';
  session?: number;
  state: PlayerState;
  error?: string;
  /**
   * Warum es schiefging — gesetzt nur dort, wo der Grund eine ANDERE Reaktion
   * verlangt als der Regelfall. `gpu-reset`: der Treiber hat die Karte
   * zurueckgesetzt und den Player-Prozess mitgerissen; der Hauptprozess faehrt
   * den naechsten Start ohne Hardware-Dekodierung, ein Neuversuch ist deshalb
   * inhaltlich ein anderer und lohnt (s. `desktop/electron/player-hwdec-wacht.ts`).
   */
  reason?: 'gpu-reset';
}

function api() {
  return typeof window !== 'undefined' ? window.pulse?.player : undefined;
}

/**
 * Ob der native Player benutzbar ist. Fragt den Main-Prozess, ob das Binary
 * gefunden wurde — nicht nur, ob die Bruecke existiert.
 */
export async function isPlayerAvailable(): Promise<boolean> {
  if (!isElectron()) return false;
  const p = api();
  if (!p) return false;
  try {
    return await p.available();
  } catch {
    return false;
  }
}

/**
 * Oeffnet einen Stream im nativen Fenster.
 *
 * `whepUrl` wird unveraendert durchgereicht — sie traegt bereits das
 * `?token=`, das media-svc nach dem Membership-Check gemintet hat.
 *
 * Liefert die Sitzungsnummer oder `null`, wenn es nicht geklappt hat. `null`
 * ist das Signal zum Rueckfall auf den `<video>`-Weg, kein Fehlerfall.
 */
export async function openPlayer(
  whepUrl: string,
  opts: {
    title?: string;
    fullscreen?: boolean;
    options?: PulsePlayerOptions;
    /** Kann die App das Bild notfalls selbst zeigen? Bei AV1 10 bit nicht —
     *  dann bietet die Leiste im Fenster kein „wieder in der App zeigen" an
     *  (der Knopf koennte sein Versprechen nicht halten). */
    canReattach?: boolean;
  } = {},
): Promise<number | null> {
  const p = api();
  if (!p) return null;
  try {
    const { canReattach, ...rest } = opts;
    const res = await p.open({
      url: whepUrl,
      ...rest,
      ...(canReattach === undefined ? {} : { can_reattach: canReattach }),
    });
    if (!res.ok) {
      console.warn('[player] open fehlgeschlagen:', res.error);
      return null;
    }
    return typeof res.session === 'number' ? res.session : null;
  } catch (e) {
    console.warn('[player] open warf:', e);
    return null;
  }
}

export async function closePlayer(session: number): Promise<void> {
  try {
    await api()?.close(session);
  } catch {
    // Schliessen darf nie stoeren — der Prozess raeumt spaetestens beim Beenden auf.
  }
}

export async function setPlayerOptions(
  session: number,
  options: PulsePlayerOptions,
): Promise<void> {
  try {
    await api()?.setOptions(session, options);
  } catch (e) {
    console.warn('[player] setOptions warf:', e);
  }
}

/** Fenster nach vorne holen — der Knopf in der Kachel. Scheitern ist kein
 *  Fehlerfall (Wayland laesst ein Fenster sich nicht selbst nach vorne
 *  zwingen), deshalb still. */
export async function focusPlayer(session: number): Promise<void> {
  try {
    await api()?.focus(session);
  } catch (e) {
    console.warn('[player] focus warf:', e);
  }
}

export async function playerStats(session: number): Promise<PulsePlayerResult | null> {
  try {
    const res = await api()?.stats(session);
    return res?.ok ? res : null;
  } catch {
    return null;
  }
}

/**
 * Abonniert Zustandsereignisse. Liefert eine Abmelde-Funktion (im Browser eine
 * leere, damit Aufrufer nicht unterscheiden muessen).
 */
export function onPlayerEvent(cb: (ev: PlayerStateEvent) => void): () => void {
  const p = api();
  if (!p) return () => {};
  return p.onEvent((raw) => {
    const ev = raw as Partial<PlayerStateEvent>;
    if (ev?.ev === 'player:state' && typeof ev.state === 'string') {
      cb(ev as PlayerStateEvent);
    }
  });
}

/**
 * Der Nutzer hat im Fenster auf Schliessen oder Chat gedrueckt.
 *
 * Beide brauchen die App: das Fenster kann eine Kachel nicht selbst schliessen
 * und den Chat nicht selbst anzeigen. `player:closeRequest` ist dabei der
 * einzige Weg, einen erzwungenen 10-bit-Stream loszuwerden — ein blosses
 * Fensterkreuz hiesse dort „zeig es wieder in der App", was nicht geht.
 */
export function onPlayerWindowRequest(
  cb: (
    kind: 'close' | 'chat' | 'remote-disconnect' | 'remote-screen',
    session: number,
    /** Nur bei `remote-screen`: die Nummer des gewaehlten Bildschirms. */
    monitor?: number,
  ) => void,
): () => void {
  const p = api();
  if (!p) return () => {};
  return p.onEvent((raw: unknown) => {
    const ev = raw as { ev?: string; session?: number; monitor?: number };
    if (typeof ev?.session !== 'number') return;
    if (ev.ev === 'player:closeRequest') cb('close', ev.session);
    else if (ev.ev === 'player:chatRequest') cb('chat', ev.session);
    // „Fernsteuerung beenden" aus dem Menü am Griff im Player-Fenster. Der
    // Player schaltet dabei NICHTS selbst ab: die Sitzung lebt hier, und nur
    // von hier aus lässt sie sich beim Gegenüber sauber auflösen. Das
    // Abschalten der Erfassung kommt anschließend auf dem gewohnten Weg
    // zurück (`RemoteControllerInput.svelte`).
    else if (ev.ev === 'player:remoteDisconnect') cb('remote-disconnect', ev.session);
    // Bildschirm-Wunsch aus dem Menue am Griff. Das Fenster schaltet nichts
    // selbst — es kennt weder Geraet noch Sitzung; angefordert wird in der App
    // (`$lib/devices/schirme.svelte.ts`).
    else if (ev.ev === 'player:remoteScreen' && typeof ev.monitor === 'number') {
      cb('remote-screen', ev.session, ev.monitor);
    }
  });
}

/** Eine im FENSTER geänderte Option (heute nur die Lautstärke). Der Player
 *  meldet das von sich aus, damit die App den Wert behalten kann — sonst wäre
 *  ein Regeln im Fenster beim nächsten Öffnen wieder weg. */
export interface PlayerOptionEvent {
  session: number;
  volume?: number;
}

export function onPlayerOptionEvent(cb: (ev: PlayerOptionEvent) => void): () => void {
  const p = api();
  if (!p) return () => {};
  return p.onEvent((raw) => {
    const ev = raw as { ev?: string; session?: unknown; volume?: unknown };
    if (ev?.ev !== 'player:option' || typeof ev.session !== 'number') return;
    cb({
      session: ev.session,
      volume: typeof ev.volume === 'number' ? ev.volume : undefined,
    });
  });
}

/**
 * Aufnahme und Clip liefern denselben Umschlag: `ok` plus den Zielpfad, den
 * der Hauptprozess bestimmt hat. `null` heisst "hat nicht geklappt" — auch
 * hier ist ein Fehlschlag kein Ausnahmefall, den der Aufrufer fangen muss.
 */
async function recordingPath(
  what: string,
  call: () => Promise<PulsePlayerResult> | undefined,
): Promise<string | null> {
  try {
    const res = await call();
    if (!res?.ok) {
      console.warn(`[player] ${what} fehlgeschlagen:`, res?.error);
      return null;
    }
    return typeof res.path === 'string' ? res.path : null;
  } catch (e) {
    console.warn(`[player] ${what} warf:`, e);
    return null;
  }
}

/**
 * Startet einen Mitschnitt. Der Zielpfad wird vom Hauptprozess bestimmt —
 * der Renderer darf keinen vorgeben, sonst waere das ein Schreibzugriff an
 * beliebige Stelle. Liefert den Pfad zurueck oder `null` bei Fehlschlag.
 */
export function startRecording(session: number): Promise<string | null> {
  return recordingPath('Aufnahme', () => api()?.record(session));
}

export async function stopRecording(session: number): Promise<boolean> {
  try {
    const res = await api()?.stopRecord(session);
    if (!res?.ok) console.warn('[player] Stopp fehlgeschlagen:', res?.error);
    return res?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Sichert die letzten `seconds` Sekunden aus dem Ringpuffer des Players.
 * Der Schnitt beginnt am letzten Keyframe davor, der Clip wird also etwas
 * laenger als angefordert.
 */
export function saveClip(session: number, seconds = 30): Promise<string | null> {
  return recordingPath('Clip', () => api()?.clip(session, seconds));
}
