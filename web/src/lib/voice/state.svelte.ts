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

/**
 * True while the local user is still connected to the voice channel that backs
 * the given watch party. The `WatchPartyTile` lives only while its voice
 * channel is the one being *viewed* in the UI, so it unmounts on any nav to a
 * text channel / another community — but the LiveKit voice connection (and thus
 * the party) keeps running. Pulled out of the tile so the
 * "suppress watch_leave on mere UI navigation" decision is unit-testable.
 *
 * A real voice leave / channel switch (`voice.disconnect`) flips `voiceState`
 * to disconnected *before* the tile unmounts, so this returns false there and
 * the normal watch_leave runs (correct for viewers; the host's party is already
 * ended via stopWatchParty on that path).
 */
export function inVoiceChannel(channelId: string): boolean {
  return voiceState.connected && voiceState.channelId === channelId;
}
