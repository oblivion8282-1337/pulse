<!--
  WatchPartyStartButton — Header-Toolbar-Button mit Inline-Popover, in den
  man eine YouTube-/Twitch-VOD-/Direct-Video-URL pastet. Live-Validation per
  `parseSource()`; auf „Start" wird `gateway.startWatchParty` aufgerufen.

  Disabled wenn schon eine Party im Channel läuft (das Tile lebt dann eh
  schon im StreamGrid). Klick außerhalb schließt das Popover.
-->
<script lang="ts">
  import PlayCircleIcon from '@lucide/svelte/icons/play-circle';
  import { toast } from 'svelte-sonner';
  import { watchPartyPresence } from '$lib/stores/watchPartyPresence.svelte';
  import { gateway } from '$lib/ws/connection';
  import { parseSource } from '$lib/watch/source';

  interface Props {
    channelId: string;
  }

  let { channelId }: Props = $props();

  let open = $state(false);
  let url = $state('');
  let inputEl = $state<HTMLInputElement | undefined>();

  const active = $derived(watchPartyPresence.partyIn(channelId) !== undefined);
  const parsed = $derived(url.trim() ? parseSource(url.trim()) : null);
  const showParseError = $derived(url.trim().length > 0 && parsed === null);

  function toggle(): void {
    if (active) return;
    open = !open;
    if (open) {
      // focus shortly after render
      queueMicrotask(() => inputEl?.focus());
    }
  }

  function start(): void {
    if (!parsed) return;
    const ok = gateway.startWatchParty(channelId, url.trim());
    if (!ok) {
      toast.error('Watch Party konnte nicht gestartet werden', {
        description: 'WebSocket nicht verbunden'
      });
      return;
    }
    url = '';
    open = false;
  }

  function handleKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      start();
    } else if (e.key === 'Escape') {
      open = false;
    }
  }

  // Reset state when the channel switches.
  $effect(() => {
    void channelId;
    open = false;
    url = '';
  });
</script>

<div class="relative">
  <button
    type="button"
    class="hover:bg-bg-hover hover:text-primary rounded-full p-2 transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-inherit"
    onclick={toggle}
    aria-label="Watch Party starten"
    aria-pressed={open}
    aria-haspopup="dialog"
    disabled={active}
    data-testid="watch-party-start-button"
    title={active ? 'Watch Party läuft bereits' : 'Watch Party starten'}
  >
    <PlayCircleIcon class="text-text-muted size-4" />
  </button>

  {#if open}
    <!-- click-outside catcher -->
    <button
      type="button"
      class="fixed inset-0 z-10 cursor-default bg-transparent"
      aria-label="Schließen"
      onclick={() => (open = false)}
    ></button>
    <div
      class="border-border bg-bg-chat absolute right-0 top-full z-20 mt-1 w-80 rounded-xl border p-3 shadow-xl backdrop-blur-xl"
      role="dialog"
      aria-label="Watch Party · Quelle einfügen"
      data-testid="watch-party-popover"
    >
      <p class="text-text-bright mb-2 text-xs font-medium">Watch Party · Quelle</p>
      <input
        bind:this={inputEl}
        bind:value={url}
        onkeydown={handleKey}
        type="url"
        placeholder="YouTube / Twitch-VOD / .mp4-Link"
        class="border-border bg-bg-elev focus:border-primary text-text-bright w-full rounded-md border px-2 py-1.5 text-sm outline-none"
        data-testid="watch-party-url-input"
      />
      <div class="mt-2 flex items-center justify-between gap-2 text-xs">
        {#if showParseError}
          <span class="text-red-400" data-testid="watch-party-parse-error">URL nicht unterstützt</span>
        {:else if parsed}
          <span class="text-text-muted" data-testid="watch-party-parse-ok">
            {parsed.type === 'youtube'
              ? 'YouTube'
              : parsed.type === 'twitch'
                ? 'Twitch VOD'
                : 'Direkt-Video'}
          </span>
        {:else}
          <span class="text-text-muted">YouTube, Twitch-VOD, mp4/webm/m3u8</span>
        {/if}
        <button
          type="button"
          onclick={start}
          disabled={!parsed}
          class="bg-primary text-bg shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-opacity disabled:opacity-40"
          data-testid="watch-party-start-confirm"
        >
          Start
        </button>
      </div>
    </div>
  {/if}
</div>
