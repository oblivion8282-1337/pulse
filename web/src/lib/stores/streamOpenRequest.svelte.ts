/**
 * One-shot signal "open the stream view for channel X on its next mount,
 * optionally focused on a specific user's content".
 *
 * The LIVE-Badge in the sidebar's voice-member list is far from the
 * `VoiceChannelView` that owns the stream-view state, and the click also has
 * to navigate first if the user is on a different channel. Instead of plumbing
 * a callback through five components or pushing a query param into the URL,
 * the badge writes a pending request here and `VoiceChannelView` consumes it
 * on (re)mount / channel change.
 *
 * A `focusUid` narrows the grid to just that user's tiles (HQ stream + screen-
 * share + cam + the watch-party they host) — clicking person X's badge should
 * open person X's content, not the whole channel-wide gallery.
 *
 * Consume-on-read means the request is "used up" — re-entering the same
 * channel later won't re-open the stream view.
 */
export type StreamFocus = {
  channelId: string;
  /** App user id (snowflake) whose tiles should be the only ones shown.
   *  Omit / null = open the full channel gallery (legacy behaviour). */
  focusUid: string | null;
};

class StreamOpenRequest {
  #pending = $state<StreamFocus | null>(null);

  /** Reactive read of the pending request — use to subscribe an effect to
   *  badge clicks even when the viewer is already on the target channel. */
  get pending(): StreamFocus | null {
    return this.#pending;
  }

  /** Mark this channel's stream view for opening on next mount, optionally
   *  focused on one user's tiles. */
  request(channelId: string, focusUid: string | null = null): void {
    this.#pending = { channelId, focusUid };
  }

  /** Return + clear any pending request for this channel. */
  consume(channelId: string): StreamFocus | null {
    const p = this.#pending;
    if (p && p.channelId === channelId) {
      this.#pending = null;
      return p;
    }
    return null;
  }
}

export const streamOpenRequest = new StreamOpenRequest();
