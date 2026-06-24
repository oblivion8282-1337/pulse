<!--
  WatchPartyStartButton — icon button in the VoiceControlBar. Several parties
  can run in one channel at once (like multiple streams):
   - No party live → grey button, click opens the start dialog directly.
   - ≥1 party live → RED button, click opens a manage menu: a stop item for
     each party YOU host, plus "start a new one". Stopping is still also
     available per-tile; this just gives the familiar one-click stop from the
     bar back. The freshly-created party's tile auto-opens for the host via the
     `watch_started` ack.

  The URL-entry dialog itself lives in the shared WatchSourceDialog (also used
  by the per-tile "switch video" button).
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
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
  import WatchSourceDialog from './WatchSourceDialog.svelte';
  import { m } from '$lib/paraglide/messages.js';

  interface Props {
    channelId: string;
  }

  let { channelId }: Props = $props();

  let open = $state(false);

  // Red "active" cue when at least one party runs in this channel. While active
  // the button opens a small menu: stop each party YOU host, plus "start a new
  // one". With no party it opens the start dialog directly.
  const active = $derived(watchPartyPresence.hasAnyParty(channelId));
  const myParties = $derived(
    watchPartyPresence.partiesHostedBy(channelId, currentServerUserId() ?? '')
  );

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

  // The host's tile opens itself when the `watch_started` ack arrives with the
  // freshly-minted party_id (we don't know it here yet).
  function start(url: string): boolean {
    const ok = gateway.startWatchParty(channelId, url);
    if (!ok) {
      toast.error(m.watch_party_start_button_start_failed(), {
        description: m.watch_party_start_button_ws_not_connected()
      });
    }
    return ok;
  }

  // Reset state when the channel switches.
  $effect(() => {
    void channelId;
    open = false;
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
    <!-- w-auto overrides the default w-(--bits-dropdown-menu-anchor-width),
         which would otherwise clamp the menu to the tiny icon-button width and
         clip the text. -->
    <DropdownMenu.Content
      align="start"
      side="top"
      class="w-auto min-w-48"
      data-testid="watch-party-menu"
    >
      {#each myParties as p (p.party_id)}
        <DropdownMenu.Item
          onclick={() => stopParty(p)}
          class="whitespace-nowrap"
          data-testid="watch-party-menu-stop"
        >
          <StopCircleIcon class="mr-2 size-4 shrink-0 text-red-500" />
          {myParties.length === 1
            ? m.watch_party_start_button_stop_label()
            : `${m.watch_party_start_button_stop_label()} · ${shortSource(p)}`}
        </DropdownMenu.Item>
      {/each}
      <DropdownMenu.Item
        onclick={() => (open = true)}
        class="whitespace-nowrap"
        data-testid="watch-party-menu-new"
      >
        <PlusIcon class="mr-2 size-4 shrink-0" />
        {m.watch_party_start_button_start_additional()}
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

<WatchSourceDialog
  bind:open
  title={m.watch_party_start_button_dialog_title()}
  confirmLabel="Start"
  onConfirm={start}
/>
