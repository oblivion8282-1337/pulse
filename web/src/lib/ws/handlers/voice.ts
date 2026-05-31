/**
 * Voice presence handlers: `voice_state`, `voice_disconnect`,
 * `voice_override`. Deafen/mute enforcement is *soft* (LiveKit doesn't
 * gate inbound subs server-side); see the per-handler comments + the
 * matching `voice-signaling/_livekit_update_participant` note in CLAUDE.md.
 */
import { voicePresence } from '$lib/stores/voicePresence.svelte';
import { auth } from '$lib/stores/auth.svelte';
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
    if (auth.user?.id === evt.user_id) {
      void import('$lib/voice/livekit.svelte').then(({ voice }) => {
        if (voice.channelId !== evt.channel_id) return;
        void voice.disconnect();
      });
    }
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
    if (auth.user?.id === evt.user_id) {
      void import('$lib/voice/livekit.svelte').then(({ voice }) => {
        if (voice.channelId !== evt.channel_id) return;
        if (evt.deafened !== voice.deafened) voice.setDeafened(evt.deafened);
      });
    }
  });
}
