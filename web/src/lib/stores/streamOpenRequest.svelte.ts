/**
 * One-shot signal "open the stream view for channel X on its next mount".
 *
 * The LIVE-Badge in the sidebar's voice-member list is far from the
 * `VoiceChannelView` that owns the stream-view state, and the click also has
 * to navigate first if the user is on a different channel. Instead of plumbing
 * a callback through five components or pushing a query param into the URL,
 * the badge writes a pending channel id here and `VoiceChannelView` consumes
 * it on (re)mount / channel change.
 *
 * Consume-on-read means the request is "used up" — re-entering the same
 * channel later won't re-open the stream view.
 */
class StreamOpenRequest {
  #pending = $state<string | null>(null);

  /** Reactive read of the pending channel id — use to subscribe an effect to
   *  badge clicks even when the viewer is already on the target channel. */
  get pendingChannelId(): string | null {
    return this.#pending;
  }

  /** Mark this channel's stream view for opening on next mount. */
  request(channelId: string): void {
    this.#pending = channelId;
  }

  /** Return + clear any pending request for this channel. */
  consume(channelId: string): boolean {
    if (this.#pending === channelId) {
      this.#pending = null;
      return true;
    }
    return false;
  }
}

export const streamOpenRequest = new StreamOpenRequest();
