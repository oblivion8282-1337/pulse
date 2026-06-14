/**
 * Shared "open a user's watch party" logic for the per-user PARTY badges
 * (voice participant tile, left voice-member list, right member list).
 *
 * A user may host several parties at once. The badges feed their candidate
 * parties into {@link watchPartyPicker.choose}: exactly one → open it directly;
 * several → pop a small chooser dialog so the viewer picks which to open. The
 * dialog ({@link WatchPartyPickerDialog}) is mounted once globally, so the
 * badges stay plain spans — no per-badge floating menu that nested popovers /
 * context menus / overflow-hidden rails would clip.
 */
import { openedTiles } from '$lib/stream/openedTiles.svelte';
import { detachedWatchParties } from '$lib/stream/watchPartyDetach.svelte';
import { type WatchPartyState } from '$lib/stores/watchPartyPresence.svelte';
import { m } from '$lib/paraglide/messages.js';

/** Open one party's tile — focuses its popup if it's detached, else mounts the
 * inline tile via the openedTiles flag (the `watch_state` push renders it). */
export function openPartyTile(channelId: string, party: WatchPartyState): void {
  if (detachedWatchParties.has(channelId, party.party_id)) {
    detachedWatchParties.open(channelId, party.party_id);
  } else {
    openedTiles.openParty(channelId, party.party_id);
  }
}

/** Short human label for a party's source — used in the chooser dialog. */
export function partySourceLabel(party: WatchPartyState): string {
  const s = party.source;
  if (s.type === 'youtube') return `YouTube · ${s.embed_id}`;
  if (s.type === 'twitch') return `Twitch · VOD ${s.embed_id}`;
  if (s.type === 'twitch_live') return `Twitch · ${s.channel}`;
  return m.watch_party_start_button_direct_video();
}

export type PartyPickEntry = { id: string; label: string; open: () => void };

class WatchPartyPicker {
  /** Non-null while the chooser dialog is showing. */
  entries = $state<PartyPickEntry[] | null>(null);
  title = $state('');

  /** One candidate → open it straight away. Several → show the chooser. */
  choose(entries: PartyPickEntry[], title: string): void {
    if (entries.length === 0) return;
    if (entries.length === 1) {
      entries[0].open();
      return;
    }
    this.title = title;
    this.entries = entries;
  }

  close(): void {
    this.entries = null;
  }
}

export const watchPartyPicker = new WatchPartyPicker();
