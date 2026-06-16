/**
 * Voice presence handlers: `voice_state`, `voice_disconnect`,
 * `voice_override`. Deafen/mute enforcement is *soft* (LiveKit doesn't
 * gate inbound subs server-side); see the per-handler comments + the
 * matching `voice-signaling/_livekit_update_participant` note in CLAUDE.md.
 */
import { voicePresence } from '$lib/stores/voicePresence.svelte';
import { guilds } from '$lib/stores/guilds.svelte';
import { currentServerUserId } from '$lib/stores/currentServerUser';
import { registerWsHandler } from '../handler-registry';
import type { HandlerContext } from './context';

export function register(ctx: HandlerContext): void {
  registerWsHandler('voice_state', (evt) => {
    const oldIds = voicePresence.byChannel[evt.channel_id] ?? [];
    voicePresence.apply(
      evt.channel_id,
      evt.user_ids,
      evt.streaming_user_ids,
      evt.user_states,
      evt.camera_user_ids
    );
    ctx.fireVoiceDiff(evt.channel_id, oldIds, evt.user_ids);
  });

  registerWsHandler('voice_disconnect', (evt) => {
    // Server admin yanked someone out of voice. If that's us in the
    // channel we're connected to, drop the LiveKit room locally —
    // LiveKit may have already removed the participant, but the
    // explicit disconnect ensures our UI state catches up
    // immediately instead of waiting for the close event.
    if (currentServerUserId() === evt.user_id) {
      void import('$lib/voice/livekit.svelte').then(({ voice }) => {
        if (voice.channelId !== evt.channel_id) return;
        void voice.disconnect();
      });
    }
  });

  registerWsHandler('voice_move', (evt) => {
    // A mod relocated someone to another voice channel. If that's us, and
    // we're connected to the source channel, switch our LiveKit room to
    // the destination. There's no server-side room hop — each channel is
    // its own LiveKit room, so the move is enforced client-side by
    // reconnecting with a fresh token (CONNECT for the destination is
    // checked server-side at token-issue, so a forbidden move just fails
    // there and we stay put).
    if (currentServerUserId() !== evt.user_id) return;
    void import('$lib/voice/livekit.svelte').then(({ voice }) => {
      if (voice.channelId !== evt.channel_id) return;
      // Resolve the destination channel name for the connect() call (used
      // for the join sound + UI label). Fall back to an empty string —
      // connect() only needs the name cosmetically.
      const targetGuildId = guilds.guildIdForChannel(evt.target_channel_id);
      const targetName =
        (targetGuildId
          ? guilds.channelsByGuild[targetGuildId]?.find((c) => c.id === evt.target_channel_id)?.name
          : undefined) ?? '';
      void voice.connect(evt.target_channel_id, targetName);
    });
  });

  registerWsHandler('voice_override', (evt) => {
    voicePresence.applyOverride(
      evt.channel_id,
      evt.user_id,
      evt.muted,
      evt.deafened
    );
    // IMPORTANT: Deafen enforcement is *soft* (UX-only, not security).
    // LiveKit's per-participant permission model doesn't gate inbound
    // subscriptions server-side, only outbound publishes. We mute local
    // audio output and disable the toggle UI, but a tampered client can
    // still receive and play all subscribed audio. Use force-disconnect
    // (voice_disconnect) for actual enforcement. Mute is server-enforced
    // via LiveKit publish-permissions (see voice-signaling/_livekit_update_participant).
    // Lazy-imported to avoid the circular dep with voice/livekit.
    if (currentServerUserId() === evt.user_id) {
      void import('$lib/voice/livekit.svelte').then(({ voice }) => {
        if (voice.channelId !== evt.channel_id) return;
        if (evt.deafened !== voice.deafened) voice.setDeafened(evt.deafened);
      });
    }
  });
}
