<!--
  WatchPartyStartButton — icon button in the VoiceControlBar. Acts as a
  toggle: opens a start dialog when no party is running, stops the party
  with a single click when the local user is the host. Non-hosts see it
  disabled while a party is active (the host owns the lifecycle).

  Dialog instead of a popover because the VoiceControlBar sits in the
  channel-list aside which has overflow-hidden — a popover would clip.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import PlayCircleIcon from '@lucide/svelte/icons/play-circle';
  import StopCircleIcon from '@lucide/svelte/icons/stop-circle';
  import { toast } from 'svelte-sonner';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { watchPartyPresence } from '$lib/stores/watchPartyPresence.svelte';
  import { gateway } from '$lib/ws/connection';
  import { parseSource } from '$lib/watch/source';
  import { openedTiles } from '$lib/stream/openedTiles.svelte';
  import { m } from '$lib/paraglide/messages.js';

  interface Props {
    channelId: string;
  }

  let { channelId }: Props = $props();

  let open = $state(false);
  let url = $state('');

  const party = $derived(watchPartyPresence.partyIn(channelId));
  const active = $derived(party !== undefined);
  const isHost = $derived(!!party && party.host_user_id === currentServerUserId());
  const parsed = $derived(url.trim() ? parseSource(url.trim()) : null);
  const showParseError = $derived(url.trim().length > 0 && parsed === null);

  function handleClick(): void {
    if (active && isHost) {
      gateway.stopWatchParty(channelId);
      return;
    }
    open = true;
  }

  function start(): void {
    if (!parsed) return;
    const ok = gateway.startWatchParty(channelId, url.trim());
    if (!ok) {
      toast.error(m.watch_party_start_button_start_failed(), {
        description: m.watch_party_start_button_ws_not_connected()
      });
      return;
    }
    // Open the tile for the host right away — the creator shouldn't have to
    // click their own party's badge to see it. Viewers still open it via the
    // badge. (Idempotent; the `watch_state` push then mounts the player.)
    openedTiles.openParty(channelId);
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
          variant={active ? (isHost ? 'destructive' : 'default') : 'ghost'}
          size="icon-sm"
          class="size-9 md:size-8"
          onclick={handleClick}
          disabled={active && !isHost}
          aria-label={active && isHost ? m.watch_party_start_button_stop_label() : m.watch_party_start_button_start_label()}
          data-testid={active && isHost ? 'watch-party-stop-button' : 'watch-party-start-button'}
        >
          {#if active && isHost}
            <StopCircleIcon class="size-4" />
          {:else}
            <PlayCircleIcon class="size-4" />
          {/if}
        </Button>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Content>
      {active
        ? isHost
          ? m.watch_party_start_button_stop_label()
          : m.watch_party_start_button_already_running()
        : m.watch_party_start_button_start_label()}
    </Tooltip.Content>
  </Tooltip.Root>
</Tooltip.Provider>

<Dialog.Root bind:open>
  <Dialog.Content class="max-w-md" data-testid="watch-party-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.watch_party_start_button_dialog_title()}</Dialog.Title>
      <Dialog.Description>
        {m.watch_party_start_button_dialog_description()}
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
            {m.watch_party_start_button_url_unsupported()}
          </span>
        {:else if parsed}
          <span class="text-text-muted" data-testid="watch-party-parse-ok">
            {parsed.type === 'youtube'
              ? 'YouTube'
              : parsed.type === 'twitch'
                ? 'Twitch VOD'
                : parsed.type === 'twitch_live'
                  ? m.watch_party_start_button_twitch_live({ channel: parsed.channel })
                  : m.watch_party_start_button_direct_video()}
          </span>
        {:else}
          <span class="text-text-muted">
            {m.watch_party_start_button_url_hint()}
          </span>
        {/if}
      </div>
    </div>
    <Dialog.Footer>
      <Button variant="ghost" onclick={() => (open = false)}>{m.watch_party_start_button_cancel()}</Button>
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
