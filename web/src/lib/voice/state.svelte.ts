/**
 * Lightweight voice-connection state for components that only need to know
 * "which channel are we in + are we connected?" without pulling in livekit-client.
 *
 * `livekit.svelte.ts` writes here; ChannelList and app/+layout read from here.
 */

class VoiceState {
  channelId = $state<string | null>(null);
  connected = $state(false);
}

export const voiceState = new VoiceState();
