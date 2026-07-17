<!--
  WatchPartyPickerDialog — global chooser shown when a user hosts more than one
  watch party and someone clicks their PARTY badge. Mounted once in the app
  layout; driven by the `watchPartyPicker` store. Single-party clicks never open
  this (they open directly) — see lib/watch/openParty.svelte.ts.

  Labels are rendered reactively from each party's source so a YouTube entry
  shows its real title (fetched via oEmbed) instead of the cryptic embed id.
-->
<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import ClapperboardIcon from '@lucide/svelte/icons/clapperboard';
  import { watchPartyPicker, type PartyPickEntry } from '$lib/watch/openParty.svelte';
  import type { WatchPartyState } from '$lib/stores/watchPartyPresence.svelte';
  import { prefetchYoutubeTitle, youtubeTitle } from '$lib/watch/youtubeMeta.svelte';
  import { m } from '$lib/paraglide/messages.js';

  const open = $derived(watchPartyPicker.entries !== null);
  const entries = $derived(watchPartyPicker.entries ?? []);

  // Kick off the title lookups for any YouTube parties in the list; the result
  // lands in the reactive cache that {@link label} reads.
  $effect(() => {
    for (const e of entries) {
      if (e.party.source.type === 'youtube') prefetchYoutubeTitle(e.party.source.embed_id);
    }
  });

  /** What this party is playing — title-aware for YouTube, platform + id/channel
   * otherwise. Reactive: re-renders when a YouTube title arrives. */
  function sourceLabel(party: WatchPartyState): string {
    const s = party.source;
    if (s.type === 'youtube') {
      const t = youtubeTitle(s.embed_id);
      return t ? `YouTube · ${t}` : `YouTube · ${s.embed_id}`;
    }
    if (s.type === 'twitch') return `Twitch · VOD ${s.embed_id}`;
    if (s.type === 'twitch_live') return `Twitch · ${s.channel}`;
    try {
      return new URL(s.url).hostname;
    } catch {
      return m.watch_party_start_button_direct_video();
    }
  }

  function label(e: PartyPickEntry): string {
    const base = sourceLabel(e.party);
    return e.suffix ? `${base} · ${e.suffix}` : base;
  }
</script>

<Dialog.Root
  {open}
  onOpenChange={(o) => {
    if (!o) watchPartyPicker.close();
  }}
>
  <Dialog.Content class="max-w-sm" data-testid="watch-party-picker">
    <Dialog.Header>
      <Dialog.Title>{watchPartyPicker.title}</Dialog.Title>
    </Dialog.Header>
    <!-- min-w-0: Dialog.Content is a CSS grid; without this the grid column
         keeps min-width:auto and a long title pushes past the frame. -->
    <div class="flex min-w-0 flex-col gap-1.5 py-1">
      {#each entries as e (e.id)}
        <button
          type="button"
          class="hover:bg-bg-hover flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors"
          data-testid="watch-party-picker-item"
          title={label(e)}
          onclick={() => {
            e.open();
            watchPartyPicker.close();
          }}
        >
          <ClapperboardIcon class="text-primary size-4 shrink-0" />
          <span class="min-w-0 flex-1 truncate">{label(e)}</span>
        </button>
      {/each}
    </div>
  </Dialog.Content>
</Dialog.Root>
