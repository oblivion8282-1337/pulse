import { request } from './client';
import { serversStore } from './servers.svelte';
import { isCapacitorIOS } from '$lib/platform/runtime';
import { pushGeraetId } from '$lib/platform/geraeteKennungPush';

/**
 * Anrufe aus DMs und privaten Gruppen (Übergabe P0, Anrufe-Epic).
 * Signalisierung über den chat-gateway (``/anrufe/...``, Cloud-only),
 * Medien über LiveKit — der Token kommt von voice-signaling
 * (``POST /call/token``, ``endpoint: 'voice'``), der Raumname aus der
 * Server-Antwort (der Client baut ihn nie selbst).
 */

export type AnrufArt = 'dm' | 'gruppe';

type AnrufAngabe = {
  id: string;
};

/** DMs/Gruppen sind cloud-only (Muster wie gruppen.ts) — der Aufruf muss
 *  an die Cloud geroutet werden, nicht an einen aktiven Self-Host. */
function cloudRoute(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

/**
 * Welches Gerät hier handelt — nur auf iOS, wo es einen VoIP-Token gibt.
 *
 * **Damit der Server diesem Gerät keinen Abbruch-Push schickt.** Hier ist der
 * Anruf schon zu (abgelehnt, aufgelegt) oder läuft (angenommen); ein Push
 * dorthin fände keinen Anruf, den die Hülle an CallKit melden könnte — und
 * genau so ein Push bringt iOS dazu, die App zu beenden und irgendwann keine
 * VoIP-Pushes mehr zuzustellen (Bughunt 2026-10-11, K3;
 * `services/chat-gateway/.../anruf_push.py`). Dieselbe Kennung, mit der das
 * Gerät seinen Token angemeldet hat (`voipToken.ts`).
 */
function handelndesGeraet(): { body?: { geraet_id: string } } {
  return isCapacitorIOS() ? { body: { geraet_id: pushGeraetId() } } : {};
}

/** Für den Abmelde-Pfad: dort ist der Zugangstoken schon gelöscht, wenn der
 *  Ruf ausgeht — derselbe Kniff wie bei `abmeldeFcmToken`. */
function mitTraeger(bearer?: string): { auth?: false; headers?: Record<string, string> } {
  return bearer ? { auth: false, headers: { Authorization: `Bearer ${bearer}` } } : {};
}

export function anrufStarten(art: AnrufArt, channelId: string): Promise<AnrufAngabe> {
  return request<AnrufAngabe>('/anrufe', {
    method: 'POST',
    body: { art, channel_id: channelId }
  }, cloudRoute());
}

export function anrufAnnehmen(callId: string): Promise<void> {
  return request<void>(`/anrufe/${encodeURIComponent(callId)}/annehmen`, {
    method: 'POST',
    ...handelndesGeraet()
  }, cloudRoute());
}

export function anrufAblehnen(callId: string): Promise<void> {
  return request<void>(`/anrufe/${encodeURIComponent(callId)}/ablehnen`, {
    method: 'POST',
    ...handelndesGeraet()
  }, cloudRoute());
}

export function anrufAuflegen(callId: string, bearer?: string): Promise<void> {
  return request<void>(`/anrufe/${encodeURIComponent(callId)}/auflegen`, {
    method: 'POST',
    ...handelndesGeraet(),
    ...mitTraeger(bearer)
  }, cloudRoute());
}

type AnrufTokenResponse = {
  token: string;
  ws_url: string;
  room: string;
};

/** Auch der Token kommt von der CLOUD: voice-signaling prüft die
 *  Mitgliedschaft über die Anruf-Route des chat-gateway, und die gibt es nur
 *  dort (Cloud-only). Bis zum 2026-10-11 ging der Ruf an den AKTIVEN Server
 *  — mit einem Self-Host davor fragte dessen voice-signaling nach einer
 *  Route, die es dort nicht gibt (am Code gefolgert, nicht nachgestellt;
 *  dieselbe Klasse wie Bughunt T2). */
export function getAnrufToken(callId: string): Promise<AnrufTokenResponse> {
  return request<AnrufTokenResponse>('/call/token', {
    method: 'POST',
    body: { call_id: callId },
    endpoint: 'voice'
  }, cloudRoute());
}
