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
