/**
 * Voice-Auto-Connect: ein fest gewählter Voice-Channel, dem die App beim Start
 * automatisch beitritt (Kontextmenü „Beim Start automatisch beitreten",
 * Blitz-Marker in der Kanal-Liste).
 *
 * Abgrenzung zu `resume.ts`: Resume ist der *unsichtbare* Reload-Rejoin
 * (sessionStorage, letzter Live-Zustand, hat Vorrang). Auto-Connect ist die
 * *explizite* Dauer-Wahl des Users — gerätelokal in localStorage, bewusst
 * NICHT account-übergreifend synchronisiert (Handy und Desktop dürfen sich
 * unterscheiden).
 *
 * Der Eintrag ist an den User gebunden (`userId`): auf einem geteilten Gerät
 * joint ein anderer Account nicht in fremde Channels; nach Sign-out/Sign-in
 * desselben Accounts bleibt die Wahl erhalten (deshalb kein Clear-on-Signout).
 */
import { voice } from './livekit.svelte';
import { activeServer } from '$lib/stores/active-server.svelte';
import { currentServerUserId } from '$lib/stores/currentServerUser';
import { voicePresence } from '$lib/stores/voicePresence.svelte';

const KEY = 'pulse.voice.autoconnect';

export type VoiceAutoConnectTarget = {
  /** Server-Kontext der Wahl — gejoint wird nur auf genau diesem Server. */
  serverId: string;
  /** Server-lokale User-ID zum Zeitpunkt der Wahl (Account-Bindung). */
  userId: string;
  channelId: string;
  /** Anzeige-Name für das Voice-Dock; kann nach Rename stale sein (kosmetisch). */
  channelName: string;
};

function load(): VoiceAutoConnectTarget | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as VoiceAutoConnectTarget;
    return t && typeof t.channelId === 'string' && typeof t.serverId === 'string' ? t : null;
  } catch {
    return null;
  }
}

class VoiceAutoConnectStore {
  target = $state<VoiceAutoConnectTarget | null>(load());

  set(target: VoiceAutoConnectTarget): void {
    this.target = target;
    try {
      localStorage.setItem(KEY, JSON.stringify(target));
    } catch {
      /* localStorage voll/blockiert → Wahl gilt nur für diese Session */
    }
  }

  clear(): void {
    this.target = null;
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignorieren */
    }
  }

  /** Ist `channelId` der Auto-Connect-Channel des AKTUELLEN Users auf dem
   *  AKTUELLEN Server? (Marker + Kontextmenü-Zustand in der Kanal-Liste.) */
  isTarget(channelId: string): boolean {
    const t = this.target;
    return (
      !!t &&
      t.channelId === channelId &&
      t.serverId === activeServer.serverId &&
      t.userId === currentServerUserId()
    );
  }
}

export const voiceAutoConnect = new VoiceAutoConnectStore();

/**
 * Nach dem Boot aufrufen — NACH `resumeVoiceIfPending()` (der Reload-Resume
 * trägt den echten letzten Zustand und gewinnt). Gates:
 *  - kein Join, wenn schon (ver)bunden (auch: Resume hat gerade verbunden);
 *  - nur im gemerkten Server-/Account-Kontext;
 *  - nur im sichtbaren Tab (ein vergessener Hintergrund-Tab joint nicht);
 *  - nicht, wenn der User laut Presence schon im Channel ist (anderes Gerät —
 *    eine zweite LiveKit-Session mit gleicher Identity würde die erste kicken);
 *  - Join erfolgt ENTMUTET (User-Wunsch; das Hot-Mic-Risiko ist akzeptiert).
 * Fehlschlag (Channel weg, Token verweigert) → still aufgeben; die Wahl bleibt
 * bestehen (könnte transient sein), es gibt keinen Retry in derselben Session.
 */
export async function autoConnectIfConfigured(): Promise<void> {
  const t = voiceAutoConnect.target;
  if (!t) return;
  if (voice.connected || voice.connecting) return;
  if (t.serverId !== activeServer.serverId) return;
  if (t.userId !== currentServerUserId()) return;
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  if (voicePresence.usersIn(t.channelId).includes(t.userId)) return;
  try {
    // startMuted: false — bewusste User-Entscheidung (2026-06-12): immer
    // entmutet joinen, das Hot-Mic-Risiko beim App-Start ist akzeptiert.
    await voice.connect(t.channelId, t.channelName, { startMuted: false });
  } catch {
    /* Channel gelöscht / kein Zugriff / Voice down → kein Auto-Join diesmal */
  }
}
