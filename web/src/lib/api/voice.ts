import { request } from './client';

export type VoiceTokenResponse = {
  token: string;
  ws_url: string;
  room: string;
};

/**
 * Ask the voice-signaling service for a LiveKit access token for the
 * given channel. The returned `ws_url` + `token` are fed straight into
 * `Room.connect()` in `lib/voice/livekit.svelte.ts`.
 */
export function getVoiceToken(channelId: string, kind: 'voice' | 'screen' = 'voice'): Promise<VoiceTokenResponse> {
  return request<VoiceTokenResponse>('/token', {
    method: 'POST',
    body: { channel_id: channelId, kind },
    endpoint: 'voice'
  });
}

export type VoiceOverrideResponse = { muted: boolean; deafened: boolean };

/** Patch the voice-override for a participant. Each field is
 * independently permission-gated server-side (``MUTE_MEMBERS`` /
 * ``DEAFEN_MEMBERS``); pass only the fields you intend to change. */
export function setVoiceOverride(
  channelId: string,
  userId: string,
  patch: { mute?: boolean; deafen?: boolean }
): Promise<VoiceOverrideResponse> {
  return request<VoiceOverrideResponse>(
    `/channels/${channelId}/members/${userId}/voice-override`,
    { method: 'PUT', body: patch, endpoint: 'voice' }
  );
}
