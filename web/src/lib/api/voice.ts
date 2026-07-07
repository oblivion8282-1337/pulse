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

/** Kick the participant out of the voice channel. Requires
 * ``MOVE_MEMBERS``. Best-effort — LiveKit silently no-ops if the user
 * isn't currently connected. The override (if any) is cleared. */
export function disconnectFromVoice(
  channelId: string,
  userId: string
): Promise<{ disconnected: boolean }> {
  return request<{ disconnected: boolean }>(
    `/channels/${channelId}/members/${userId}/voice-disconnect`,
    { method: 'POST', endpoint: 'voice' }
  );
}

/** Bring ``userId`` into the voice channel ``channelId`` — a channel
 * switch if they're connected elsewhere, or a summon if they aren't.
 * Grants a temporary VIEW_CHANNEL|CONNECT grant when they lack it and
 * signals their client to connect (``voice_pull`` event). Requires
 * MOVE_MEMBERS on the channel; the grant auto-revokes when they leave.
 * This is a chat-gateway route (not voice-signaling), hence
 * ``endpoint: 'chat'``. */
export function moveIntoVoiceChannel(
  channelId: string,
  userId: string
): Promise<{ pulled: boolean }> {
  return request<{ pulled: boolean }>(
    `/channels/${channelId}/members/${userId}/voice-move`,
    { method: 'POST', endpoint: 'chat' }
  );
}
