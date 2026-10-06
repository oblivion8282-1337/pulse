<!--
  WatchQueuePanel — die gemeinsame Warteschlange einer Watch-Party (Seiten-
  panel, analog zum Chat). Jede:r im Kanal reiht Videos ein; der Host zieht sie
  vor oder entfernt sie, ein Einreicher darf seine eigenen wieder herausnehmen.

  Reine Hülle über den WS-Ops (gateway.watchQueue*) — der State kommt vom
  Server-Push (party.queue), das Panel hält keinen eigenen Queue-Zustand.
  Reorder per Drag ist bewusst (noch) nicht dabei; „vorziehen" deckt den
  häufigsten Fall (dieses jetzt spielen) schon ab.
-->
<script lang="ts">
  import { toast } from 'svelte-sonner';
  import XIcon from '@lucide/svelte/icons/x';
  import PlayIcon from '@lucide/svelte/icons/play';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import ListVideoIcon from '@lucide/svelte/icons/list-video';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import { gateway } from '$lib/ws/connection';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { userCache } from '$lib/stores/users.svelte';
  import { prefetchYoutubeTitle, youtubeTitle } from '$lib/watch/youtubeMeta.svelte';
  import type { WatchPartyState, WatchSource } from '$lib/stores/watchPartyPresence.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    channelId,
    partyId,
    party,
    onClose
  }: {
    channelId: string;
    partyId: string;
    party: WatchPartyState;
    onClose: () => void;
  } = $props();

  const myId = $derived(currentServerUserId());
  const isHost = $derived(!!myId && party.host_user_id === myId);
  const queue = $derived(party.queue ?? []);

  // Titel der YouTube-Quellen lazy vorladen (aktuelle + alle in der Schlange).
  $effect(() => {
    if (party.source.type === 'youtube') prefetchYoutubeTitle(party.source.embed_id);
    for (const item of queue) {
      if (item.source.type === 'youtube') prefetchYoutubeTitle(item.source.embed_id);
    }
  });

  function label(source: WatchSource): string {
    if (source.type === 'youtube') {
      return youtubeTitle(source.embed_id) ?? `YouTube · ${source.embed_id}`;
    }
    if (source.type === 'twitch') return `Twitch · VOD ${source.embed_id}`;
    if (source.type === 'twitch_live') return `Twitch · ${source.channel}`;
    try {
      return new URL(source.url).hostname;
    } catch {
      return m.watch_party_tile_direct_video();
    }
  }

  // YouTube-Vorschaubild (kein API-Call, nur eine img-URL). Andere Quellen
  // bekommen einen Icon-Platzhalter.
  function thumb(source: WatchSource): string | null {
    return source.type === 'youtube'
      ? `https://i.ytimg.com/vi/${source.embed_id}/mqdefault.jpg`
      : null;
  }

  const canRemove = (submittedBy: string) => isHost || submittedBy === myId;

  let addUrl = $state('');
  function submitAdd(): void {
    const url = addUrl.trim();
    if (!url) return;
    if (gateway.watchQueueAdd(channelId, partyId, url)) {
      addUrl = '';
    } else {
      toast.error(m.watch_queue_add_failed());
    }
  }
  function playNow(itemId: string): void {
    gateway.watchQueueAdvance(channelId, partyId, itemId);
  }
  function remove(itemId: string): void {
    gateway.watchQueueRemove(channelId, partyId, itemId);
  }
</script>

<div
  class="glass-panel flex h-full w-full flex-col overflow-hidden border-l border-border md:w-72"
  data-testid="watch-queue-panel"
>
  <header class="flex items-center gap-2 border-b border-border px-3 py-2.5">
    <ListVideoIcon class="text-primary size-4 shrink-0" />
    <span class="text-text-bright flex-1 text-sm font-semibold">{m.watch_queue_title()}</span>
    {#if queue.length > 0}
      <span
        class="bg-badge-count rounded-full px-1.5 text-2xs font-bold text-white tabular-nums"
        data-testid="watch-queue-count"
      >{queue.length}</span>
    {/if}
    <button
      type="button"
      onclick={onClose}
      class="text-text-muted hover:text-text-bright rounded-md p-1"
      aria-label={m.watch_queue_close()}
      data-testid="watch-queue-close"
    >
      <XIcon class="size-4" />
    </button>
  </header>

  <div class="flex-1 overflow-y-auto px-2 py-2">
    <!-- Jetzt läuft -->
    <p class="text-text-muted px-2 pb-1 text-2xs font-semibold uppercase tracking-wide">
      {m.watch_queue_now_playing()}
    </p>
    <div class="border-primary/40 bg-primary/10 mb-3 flex items-center gap-2.5 rounded-lg border p-2">
      <div class="aspect-video w-16 shrink-0 overflow-hidden rounded bg-black">
        {#if thumb(party.source)}
          <img src={thumb(party.source)} alt="" class="size-full object-cover" />
        {/if}
      </div>
      <span class="text-text-bright line-clamp-2 text-xs font-medium">{label(party.source)}</span>
    </div>

    <!-- Als Nächstes -->
    <p class="text-text-muted px-2 pb-1 text-2xs font-semibold uppercase tracking-wide">
      {m.watch_queue_up_next()}
    </p>
    {#if queue.length === 0}
      <p class="text-text-faint px-2 py-3 text-xs" data-testid="watch-queue-empty">
        {m.watch_queue_empty()}
      </p>
    {:else}
      <ul class="flex flex-col gap-1">
        {#each queue as item (item.id)}
          <li
            class="hover:bg-bg-hover group flex items-center gap-2.5 rounded-lg p-1.5"
            data-testid="watch-queue-item"
          >
            <div class="aspect-video w-16 shrink-0 overflow-hidden rounded bg-black">
              {#if thumb(item.source)}
                <img src={thumb(item.source)} alt="" class="size-full object-cover" />
              {:else}
                <div class="text-text-faint grid size-full place-items-center">
                  <ListVideoIcon class="size-4" />
                </div>
              {/if}
            </div>
            <div class="min-w-0 flex-1">
              <p class="text-text-base line-clamp-2 text-xs font-medium">{label(item.source)}</p>
              <p class="text-text-muted mt-0.5 truncate text-2xs">
                {m.watch_queue_submitted_by({ name: userCache.displayName(item.submitted_by) })}
              </p>
            </div>
            <div class="flex shrink-0 items-center gap-0.5">
              {#if isHost}
                <button
                  type="button"
                  onclick={() => playNow(item.id)}
                  class="text-text-muted hover:bg-primary hover:text-white rounded-md p-1.5"
                  aria-label={m.watch_queue_play_now()}
                  title={m.watch_queue_play_now()}
                  data-testid="watch-queue-play-now"
                >
                  <PlayIcon class="size-3.5" />
                </button>
              {/if}
              {#if canRemove(item.submitted_by)}
                <button
                  type="button"
                  onclick={() => remove(item.id)}
                  class="text-text-muted hover:bg-destructive hover:text-white rounded-md p-1.5"
                  aria-label={m.watch_queue_remove()}
                  title={m.watch_queue_remove()}
                  data-testid="watch-queue-remove"
                >
                  <Trash2Icon class="size-3.5" />
                </button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <!-- Einreihen — jede:r im Kanal -->
  <div class="border-t border-border p-2">
    <form
      class="bg-bg-input flex items-center gap-1.5 rounded-lg border border-border px-2 py-1"
      onsubmit={(e) => {
        e.preventDefault();
        submitAdd();
      }}
    >
      <input
        bind:value={addUrl}
        placeholder={m.watch_queue_add_placeholder()}
        class="text-text-base min-w-0 flex-1 bg-transparent text-xs outline-none"
        data-testid="watch-queue-add-input"
      />
      <button
        type="submit"
        class="bg-primary flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-2xs font-semibold text-white disabled:opacity-40"
        disabled={!addUrl.trim()}
        data-testid="watch-queue-add-submit"
      >
        <PlusIcon class="size-3" />
        {m.watch_queue_add_button()}
      </button>
    </form>
    <p class="text-text-faint px-1 pt-1.5 text-2xs">{m.watch_queue_add_hint()}</p>
  </div>
</div>
