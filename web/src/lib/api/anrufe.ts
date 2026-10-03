import { request } from './client';
import { serversStore } from './servers.svelte';

/**
 * Anrufe aus DMs und privaten Gruppen (Übergabe P0, Anrufe-Epic).
 * Signalisierung über den chat-gateway (``/anrufe/...``, Cloud-only),
 * Medien über LiveKit — der Token kommt von voice-signaling
 * (``POST /call/token``, ``endpoint: 'voice'``), der Raumname aus der
 * Server-Antwort (der Client baut ihn nie selbst).
 */

export type AnrufArt = 'dm' | 'gruppe';

export type AnrufAngabe = {
  id: string;
};

/** DMs/Gruppen sind cloud-only (Muster wie gruppen.ts) — der Aufruf muss
 *  an die Cloud geroutet werden, nicht an einen aktiven Self-Host. */
function cloudRoute(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

export function anrufStarten(art: AnrufArt, channelId: string): Promise<AnrufAngabe> {
  return request<AnrufAngabe>('/anrufe', {
    method: 'POST',
    body: { art, channel_id: channelId }
  }, cloudRoute());
}

export function anrufAnnehmen(callId: string): Promise<void> {
  return request<void>(`/anrufe/${encodeURIComponent(callId)}/annehmen`, {
    method: 'POST'
  }, cloudRoute());
}

export function anrufAblehnen(callId: string): Promise<void> {
  return request<void>(`/anrufe/${encodeURIComponent(callId)}/ablehnen`, {
    method: 'POST'
  }, cloudRoute());
}

export function anrufAuflegen(callId: string): Promise<void> {
  return request<void>(`/anrufe/${encodeURIComponent(callId)}/auflegen`, {
    method: 'POST'
  }, cloudRoute());
}

export type AnrufTokenResponse = {
  token: string;
  ws_url: string;
  room: string;
};

export function getAnrufToken(callId: string): Promise<AnrufTokenResponse> {
  return request<AnrufTokenResponse>('/call/token', {
    method: 'POST',
    body: { call_id: callId },
    endpoint: 'voice'
  });
}
