import { chatApi } from '$lib/api/chat';
import type { DMChannel } from '$lib/api/types';
import { blocks } from './blocks.svelte';
import { compareSnowflakeId } from '$lib/utils/snowflake';

/**
 * Holds the caller's 1:1 DM channels. Mirrors `guilds.svelte.ts` in shape:
 * `byId` keyed by snowflake id, sorted `list` derived from it.
 *
 * Hydrated on app boot AND seeded again from `ready.dm_channels` on every
 * WS reconnect. `upsertFromBump` is called from the `dm_bump` WS handler so
 * a fresh DM (or one we created from another device) shows up live without
 * a full hydrate round-trip.
 */
class DirectMessageStore {
  byId = $state<Record<string, DMChannel>>({});
  loaded = $state(false);

  // Most-recently-active first. DMs mit letzter Nachricht oben (neueste
  // zuerst); DMs ohne Nachricht (last_message_id null) darunter, nach
  // Erstellung (id) sortiert — eine frische leere DM rutscht so nicht vor
  // aktive Threads.
  list = $derived(
    Object.values(this.byId).sort((a, b) => {
      const aMsg = a.last_message_id;
      const bMsg = b.last_message_id;
      if (aMsg && bMsg) return compareSnowflakeId(bMsg, aMsg);
      if (aMsg) return -1;
      if (bMsg) return 1;
      return compareSnowflakeId(b.id, a.id);
    })
  );

  async hydrate(): Promise<void> {
    const dms = await chatApi.listDMChannels();
    const next: Record<string, DMChannel> = {};
    for (const d of dms) next[d.id] = d;
    this.byId = next;
    this.loaded = true;
  }

  /** Replace the whole map — used when WS `ready` re-seeds the list. */
  seed(dms: DMChannel[]): void {
    const next: Record<string, DMChannel> = {};
    for (const d of dms) next[d.id] = d;
    this.byId = next;
    this.loaded = true;
  }

  upsert(dm: DMChannel): void {
    this.byId = { ...this.byId, [dm.id]: dm };
  }

  /**
   * Apply a `dm_bump` envelope. Creates the channel entry if we didn't know
   * about it yet (e.g. the other side just opened a DM with us). Returns
   * `false` if `currentUserId` isn't a member of this DM (caller should
   * ignore the bump in that case).
   */
  upsertFromBump(args: {
    channel_id: string;
    user_a_id: string;
    user_b_id: string;
    message_id: string;
    currentUserId: string;
  }): boolean {
    const { channel_id, user_a_id, user_b_id, message_id, currentUserId } = args;
    if (user_a_id !== currentUserId && user_b_id !== currentUserId) return false;
    const otherUserId = user_a_id === currentUserId ? user_b_id : user_a_id;
    const existing = this.byId[channel_id];
    const next: DMChannel = existing
      ? { ...existing, last_message_id: message_id }
      : {
          id: channel_id,
          other_user_id: otherUserId,
          last_message_id: message_id,
          // We don't know the real created_at here — use "now" as a
          // best-effort. The next hydrate (or ready) will overwrite it.
          created_at: new Date().toISOString(),
          // Derive can_send from the local blocks store when available.
          // If the other user is blocked, the composer must be disabled
          // immediately — before the next ready/hydrate fills the real flag.
          // Only set false when we're certain (blocks.loaded); leave
          // undefined otherwise so the hydrate result takes precedence.
          ...(blocks.loaded && blocks.has(otherUserId) ? { can_send: false } : {}),
        };
    this.byId = { ...this.byId, [channel_id]: next };
    return true;
  }

  /**
   * Bump fuer den verschluesselten Weg (Bughunt 2026-08-28, FIX 3). Anders
   * als `upsertFromBump` gibt es hier KEIN Server-Ereignis mit `user_a_id`/
   * `user_b_id` — der `postfach_neu`-Weckruf ist bewusst inhaltslos (Spec
   * §4), und beim Senden weiss der Server nicht einmal, dass dieses Geraet
   * gerade selbst verschickt hat. Aufrufer (`krypto/senden.ts` beim Senden,
   * `ws/handlers/chat.ts` beim Empfangen) kennen die Gegenstelle bereits aus
   * dem entschluesselten Kontext und uebergeben sie direkt, statt sie aus
   * einem Ereignis herzuleiten.
   */
  upsertFromEncrypted(args: {
    channel_id: string;
    message_id: string;
    otherUserId: string;
  }): void {
    const { channel_id, message_id, otherUserId } = args;
    const existing = this.byId[channel_id];
    const next: DMChannel = existing
      ? { ...existing, last_message_id: message_id }
      : {
          id: channel_id,
          other_user_id: otherUserId,
          last_message_id: message_id,
          // Wie bei `upsertFromBump`: die echte `created_at` kennen wir
          // hier nicht — der naechste hydrate/ready ueberschreibt sie.
          created_at: new Date().toISOString(),
          ...(blocks.loaded && blocks.has(otherUserId) ? { can_send: false } : {}),
        };
    this.byId = { ...this.byId, [channel_id]: next };
  }

  clear(): void {
    this.byId = {};
    this.loaded = false;
  }
}

export const directMessages = new DirectMessageStore();
