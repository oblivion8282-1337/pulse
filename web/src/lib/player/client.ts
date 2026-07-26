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
  opts: { title?: string; fullscreen?: boolean; options?: PulsePlayerOptions } = {},
): Promise<number | null> {
  const p = api();
  if (!p) return null;
  try {
    const res = await p.open({ url: whepUrl, ...opts });
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
