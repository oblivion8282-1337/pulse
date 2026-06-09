/**
 * Voice-Resume: nach einem Reload (manuelles F5 oder der „Neu laden"-Toast nach
 * einem Update) automatisch zurück in den Voice-Channel, in dem der User vorher
 * war — inklusive Mute/Deafen-Zustand.
 *
 * Persistenz bewusst in **sessionStorage**, nicht localStorage:
 *  - überlebt `location.reload()` / F5 im selben Tab (genau der Update-Fall),
 *  - überlebt aber NICHT das Schließen des Tabs oder einen frischen Tab → kein
 *    „Phantom-Rejoin" Tage später, wenn der User die App neu öffnet.
 *
 * Geschrieben wird beim erfolgreichen Connect und bei jeder Mute/Deafen-
 * Änderung (`livekit.svelte.ts`), gelöscht beim expliziten Verlassen
 * (Auflegen / Channel-Wechsel, `disconnect({reason:'user'})`) und beim Sign-Out
 * / Account-Switch (`auth.svelte.ts`). Eine reine Transport-Trennung (Reload,
 * WS-Blip) lässt den Eintrag absichtlich stehen.
 *
 * Bewusst dependency-frei (nur sessionStorage), damit es ohne Import-Zyklus
 * sowohl vom Voice-Store als auch vom Auth-Store genutzt werden kann.
 */

const KEY = 'pulse.voice.resume';

export type VoiceResume = {
  /** Aktiver Server zum Connect-Zeitpunkt — der Rejoin gilt nur, wenn der Boot
   *  denselben Server aktiv hat (sonst andere Token-/Membership-Welt). */
  serverId: string;
  channelId: string;
  channelName: string;
  muted: boolean;
  deafened: boolean;
};

export function saveVoiceResume(data: VoiceResume): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* sessionStorage voll/blockiert → Resume entfällt, kein harter Fehler */
  }
}

export function loadVoiceResume(): VoiceResume | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<VoiceResume>;
    if (!v || typeof v.channelId !== 'string' || !v.channelId) return null;
    return {
      serverId: typeof v.serverId === 'string' ? v.serverId : '',
      channelId: v.channelId,
      channelName: typeof v.channelName === 'string' ? v.channelName : '',
      muted: !!v.muted,
      deafened: !!v.deafened,
    };
  } catch {
    return null;
  }
}

export function clearVoiceResume(): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
