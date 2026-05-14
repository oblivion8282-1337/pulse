/**
 * Live-Chat-Store für HQ-Streams — Twitch-Style ephemerer Chat pro Streamer.
 *
 * State pro (channel, streamer)-Paar (Key = `${cid}:${uid}`). Gefüttert aus:
 *  - REST-Backfill beim Mount des `StreamChatPanel` / `StreamChatOverlay` →
 *    {@link seed} (volle Liste).
 *  - WS-Push `{op:"stream_chat_message", channel_id, streamer_id, message}` →
 *    {@link apply} (eine neue Message anhängen).
 *  - WS-Push `{op:"stream_state", channel_id, user_ids}` → {@link pruneAbsent}
 *    (Chats für Streamer löschen die nicht mehr in der Liste sind — ephemer
 *    pro Plan: Stream gone == lokaler Chat-State gone).
 *
 * Backend-TTL ist 6h — der Server droppt die Liste *nicht* aktiv beim
 * Stream-Ende (Race mit MediaMTX-Poller-Lag), das ist hier UX, nicht
 * Korrektheit.
 */

export type StreamChatMessage = {
  id: string;
  author_id: string;
  content: string;
  created_at: string;
};

// Client-seitiges Cap — der Server cappt schon bei 200, hier nur als
// Memory-Schutz wenn jemand sehr lange ein Panel offen lässt.
const MAX_CLIENT_HISTORY = 200;

function key(channelId: string, streamerId: string): string {
  return `${channelId}:${streamerId}`;
}

class StreamChatStore {
  /** Volle Message-Liste pro Stream, chronologisch (oldest → newest). */
  byStream = $state<Record<string, StreamChatMessage[]>>({});

  /** Backfill: ersetzt die komplette Liste für (channel, streamer). */
  seed(channelId: string, streamerId: string, messages: StreamChatMessage[]): void {
    const k = key(channelId, streamerId);
    // Defensive copy — die REST-Antwort soll nicht von außen mutierbar bleiben.
    const trimmed = messages.slice(-MAX_CLIENT_HISTORY);
    this.byStream = { ...this.byStream, [k]: trimmed };
  }

  /** Push-Append einer einzelnen neuen Message vom WS. Dedupliziert per id. */
  apply(channelId: string, streamerId: string, message: StreamChatMessage): void {
    const k = key(channelId, streamerId);
    const existing = this.byStream[k] ?? [];
    // Server-Echo könnte beim eigenen Send eine Message doppelt liefern wenn
    // der Client sie optimistisch lokal anlegt — id-basierte Dedup deckt das ab.
    if (existing.some((m) => m.id === message.id)) return;
    const next = existing.length >= MAX_CLIENT_HISTORY
      ? [...existing.slice(-(MAX_CLIENT_HISTORY - 1)), message]
      : [...existing, message];
    this.byStream = { ...this.byStream, [k]: next };
  }

  /** Stream ist offline / Channel-Switch → kompletter Chat raus. */
  clear(channelId: string, streamerId: string): void {
    const k = key(channelId, streamerId);
    if (this.byStream[k] === undefined) return;
    const { [k]: _drop, ...rest } = this.byStream;
    this.byStream = rest;
  }

  /** Auf `stream_state` mit aktualisiertem `user_ids` aufgerufen — droppt
   *  Chats für Streamer die nicht (mehr) in der Liste sind. */
  pruneAbsent(channelId: string, presentStreamerIds: string[]): void {
    const present = new Set(presentStreamerIds);
    const prefix = `${channelId}:`;
    let changed = false;
    const next: Record<string, StreamChatMessage[]> = {};
    for (const [k, v] of Object.entries(this.byStream)) {
      if (k.startsWith(prefix)) {
        const uid = k.slice(prefix.length);
        if (!present.has(uid)) {
          changed = true;
          continue;
        }
      }
      next[k] = v;
    }
    if (changed) this.byStream = next;
  }

  /** Read-only Slice (leeres Array wenn nichts da ist). */
  for(channelId: string, streamerId: string): StreamChatMessage[] {
    return this.byStream[key(channelId, streamerId)] ?? [];
  }
}

export const streamChat = new StreamChatStore();
