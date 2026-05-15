<!--
  WatchPartyStartButton — icon button in the VoiceControlBar that opens a
  dialog to start a watch party. URL is live-validated via the frontend
  `parseSource` mirror; the backend re-validates the WS frame.

  Disabled while a party is already active in the channel (the tile's X
  button is the way to stop). When the host starts a party, the
  VoiceChannelView auto-opens the stream grid so they immediately see the
  tile they're controlling.

  Dialog instead of a popover because the VoiceControlBar sits in the
  channel-list aside which has overflow-hidden — a popover would clip.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
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

  const active = $derived(watchPartyPresence.partyIn(channelId) !== undefined);
  const parsed = $derived(url.trim() ? parseSource(url.trim()) : null);
  const showParseError = $derived(url.trim().length > 0 && parsed === null);

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
    }
  }

  // Reset state when the channel switches.
  $effect(() => {
    void channelId;
    open = false;
    url = '';
  });
</script>

<Tooltip.Provider delayDuration={300}>
  <Tooltip.Root>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          variant={active ? 'default' : 'ghost'}
          size="icon-sm"
          onclick={() => (open = true)}
          disabled={active}
          aria-label="Watch Party starten"
          data-testid="watch-party-start-button"
        >
          <PlayCircleIcon class="size-4" />
        </Button>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Content>
      {active ? 'Watch Party läuft bereits' : 'Watch Party starten'}
    </Tooltip.Content>
  </Tooltip.Root>
</Tooltip.Provider>

<Dialog.Root bind:open>
  <Dialog.Content class="max-w-md" data-testid="watch-party-dialog">
    <Dialog.Header>
      <Dialog.Title>Watch Party starten</Dialog.Title>
      <Dialog.Description>
        YouTube, Twitch-VOD oder ein direkter mp4/webm/m3u8-Link.
      </Dialog.Description>
    </Dialog.Header>
    <div class="flex flex-col gap-2 py-2">
      <input
        bind:value={url}
        onkeydown={handleKey}
        type="url"
        placeholder="https://youtu.be/..."
        class="border-border bg-bg-elev focus:border-primary text-text-bright w-full rounded-md border px-2 py-1.5 text-sm outline-none"
        data-testid="watch-party-url-input"
      />
      <div class="text-xs">
        {#if showParseError}
          <span class="text-red-400" data-testid="watch-party-parse-error">
            URL nicht unterstützt
          </span>
        {:else if parsed}
          <span class="text-text-muted" data-testid="watch-party-parse-ok">
            {parsed.type === 'youtube'
              ? 'YouTube'
              : parsed.type === 'twitch'
                ? 'Twitch VOD'
                : 'Direkt-Video'}
          </span>
        {:else}
          <span class="text-text-muted">YouTube, Twitch-VOD oder mp4/webm/m3u8-Link</span>
        {/if}
      </div>
    </div>
    <Dialog.Footer>
      <Button variant="ghost" onclick={() => (open = false)}>Abbrechen</Button>
      <Button
        onclick={start}
        disabled={!parsed}
        data-testid="watch-party-start-confirm"
      >
        Start
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
