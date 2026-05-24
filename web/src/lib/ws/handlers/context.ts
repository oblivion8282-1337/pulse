/**
 * Handler-Context bundle.
 *
 * A few handlers need access to per-connection state the gateway owns
 * (the current `subs` set, the deletion hooks, the voice-diff sound
 * trigger). Instead of leaking those via globals, the connection passes
 * a `HandlerContext` once into `registerAll()` — every domain module
 * captures it in a closure when registering.
 *
 * That's also the seam Phase 4 (plugins) needs: a plugin handler reads
 * `ctx.subs` to decide whether the user is viewing the channel, without
 * caring about how the gateway implements subscriptions.
 */
export type HandlerContext = {
  /** Currently subscribed channel ids (live ref, not a snapshot). */
  subs: Set<string>;
  /** Drop a WS subscription. Mirrors `gateway.unsubscribe`. */
  unsubscribe: (channelId: string) => void;
  /** Fired on remote channel deletion so /channels/[id]/+page.svelte can
   * navigate away. */
  fireChannelDeleted: (guildId: string, channelId: string) => void;
  /** Fired on remote guild deletion / membership loss. */
  fireGuildDeleted: (guildId: string) => void;
  /** Fire voice join/leave sounds for the *other* users in our voice
   *  channel. Lives on the gateway because it needs the lazy import of
   *  `voice/livekit.svelte` to avoid the circular dep. */
  fireVoiceDiff: (channelId: string, oldIds: string[], newIds: string[]) => void;
};
