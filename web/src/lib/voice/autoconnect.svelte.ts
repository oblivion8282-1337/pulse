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
import { goto } from '$app/navigation';
import { voice } from './livekit.svelte';
import { activeServer } from '$lib/stores/active-server.svelte';
import { currentServerUserId } from '$lib/stores/currentServerUser';
import { voicePresence } from '$lib/stores/voicePresence.svelte';
import { navDrawer } from '$lib/stores/navDrawer.svelte';

const KEY = 'pulse.voice.autoconnect';

export type VoiceAutoConnectTarget = {
  /** Server-Kontext der Wahl — gejoint wird nur auf genau diesem Server. */
  serverId: string;
  /** Server-lokale User-ID zum Zeitpunkt der Wahl (Account-Bindung). */
  userId: string;
  channelId: string;
  /** Anzeige-Name für das Voice-Dock; kann nach Rename stale sein (kosmetisch). */
  channelName: string;
  /** Für die Navigation zur Community nach dem Auto-Join. Optional, weil
   *  Einträge der ersten Feature-Version (2026-06-12) das Feld nicht haben —
   *  dann joint die App nur, ohne zu navigieren. */
  guildId?: string;
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
    return this.validTarget()?.channelId === channelId;
  }

  /** Das Ziel, sofern es zum aktuellen Server- und Account-Kontext passt —
   *  sonst null. Gemeinsame Gültigkeits-Prüfung für Marker, Join und die
   *  Start-Navigation (/app-Redirect). */
  validTarget(): VoiceAutoConnectTarget | null {
    const t = this.target;
    if (!t) return null;
    if (t.serverId !== activeServer.serverId) return null;
    if (t.userId !== currentServerUserId()) return null;
    return t;
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
  const t = voiceAutoConnect.validTarget();
  if (!t) return;
  if (voice.connected || voice.connecting) return;
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  if (voicePresence.usersIn(t.channelId).includes(t.userId)) return;
  try {
    // startMuted: false — bewusste User-Entscheidung (2026-06-12): immer
    // entmutet joinen, das Hot-Mic-Risiko beim App-Start ist akzeptiert.
    await voice.connect(t.channelId, t.channelName, { startMuted: false });
  } catch {
    /* Channel gelöscht / kein Zugriff / Voice down → kein Auto-Join diesmal */
    return;
  }

  // Nach dem Join direkt die Community des Channels zeigen — aber NUR, wenn
  // der User auf einer Standard-Landeseite steht (ohne Query — /app?add=create
  // ist der Community-erstellen-Dialog). Einen Deep-Link (Mention,
  // Benachrichtigung, DM) reißen wir nicht weg. Den /app-eigenen Redirect in
  // den ersten Textkanal löst die Seite selbst Auto-Connect-bewusst auf
  // (routes/app/+page.svelte bevorzugt das validTarget) — beide Pfade führen
  // zum selben Ziel, der Race ist dadurch harmlos.
  const path = location.pathname;
  const onDefaultLanding =
    (path === '/app' || path === '/app/' || path === '/app/@me' || path === '/app/friends') &&
    location.search === '';
  if (t.guildId && onDefaultLanding) {
    // Mobil: Kanal-Liste zuerst (Desktop: Drawer ist statisch, wirkungslos).
    navDrawer.open = true;
    await goto(`/app/guilds/${t.guildId}/channels/${t.channelId}`);
  }
}
