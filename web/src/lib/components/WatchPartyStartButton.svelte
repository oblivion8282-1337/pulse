<!--
  WatchPartyStartButton — icon button in the VoiceControlBar. Several parties
  can run in one channel at once (like multiple streams):
   - No party live → grey button, click opens the start dialog directly.
   - ≥1 party live → RED button, click opens a manage menu: a stop item for
     each party YOU host, plus "start a new one". Stopping is still also
     available per-tile; this just gives the familiar one-click stop from the
     bar back. The freshly-created party's tile auto-opens for the host via the
     `watch_started` ack.

  Dialog instead of a popover because the VoiceControlBar sits in the
  channel-list aside which has overflow-hidden — a popover would clip.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import PlayCircleIcon from '@lucide/svelte/icons/play-circle';
  import StopCircleIcon from '@lucide/svelte/icons/stop-circle';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import { toast } from 'svelte-sonner';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { gateway } from '$lib/ws/connection';
  import {
    watchPartyPresence,
    type WatchPartyState
  } from '$lib/stores/watchPartyPresence.svelte';
  import { parseSource } from '$lib/watch/source';
  import { m } from '$lib/paraglide/messages.js';

  interface Props {
    channelId: string;
  }

  let { channelId }: Props = $props();

  let open = $state(false);
  let url = $state('');

  // Red "active" cue when at least one party runs in this channel. While active
  // the button opens a small menu: stop each party YOU host, plus "start a new
  // one". With no party it opens the start dialog directly.
  const active = $derived(watchPartyPresence.hasAnyParty(channelId));
  const myParties = $derived(
    watchPartyPresence.partiesHostedBy(channelId, currentServerUserId() ?? '')
  );
  const parsed = $derived(url.trim() ? parseSource(url.trim()) : null);
  const showParseError = $derived(url.trim().length > 0 && parsed === null);

  /** Short source descriptor — only shown when you host more than one party, to
   * tell the stop items apart. */
  function shortSource(p: WatchPartyState): string {
    const s = p.source;
    if (s.type === 'youtube') return 'YouTube';
    if (s.type === 'twitch') return 'Twitch VOD';
    if (s.type === 'twitch_live') return `Twitch · ${s.channel}`;
    return m.watch_party_start_button_direct_video();
  }

  function stopParty(p: WatchPartyState): void {
    gateway.stopWatchParty(channelId, p.party_id);
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
    // The host's tile opens itself when the `watch_started` ack arrives with
    // the freshly-minted party_id (we don't know it yet here).
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

{#if active}
  <!-- A party is live here → red button opens a manage menu. -->
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          variant="destructive"
          size="icon-sm"
          class="size-9 md:size-8"
          aria-label={m.watch_party_start_button_start_label()}
          data-testid="watch-party-start-button"
        >
          <PlayCircleIcon class="size-4" />
        </Button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end" side="top" data-testid="watch-party-menu">
      {#each myParties as p (p.party_id)}
        <DropdownMenu.Item onclick={() => stopParty(p)} data-testid="watch-party-menu-stop">
          <StopCircleIcon class="mr-2 size-4 text-red-500" />
          {myParties.length === 1
            ? m.watch_party_start_button_stop_label()
            : `${m.watch_party_start_button_stop_label()} · ${shortSource(p)}`}
        </DropdownMenu.Item>
      {/each}
      <DropdownMenu.Item onclick={() => (open = true)} data-testid="watch-party-menu-new">
        <PlusIcon class="mr-2 size-4" />
        {m.watch_party_start_button_start_label()}
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{:else}
  <Tooltip.Provider delayDuration={300}>
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            variant="ghost"
            size="icon-sm"
            class="size-9 md:size-8"
            onclick={() => (open = true)}
            aria-label={m.watch_party_start_button_start_label()}
            data-testid="watch-party-start-button"
          >
            <PlayCircleIcon class="size-4" />
          </Button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content>
        {m.watch_party_start_button_start_label()}
      </Tooltip.Content>
    </Tooltip.Root>
  </Tooltip.Provider>
{/if}

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
