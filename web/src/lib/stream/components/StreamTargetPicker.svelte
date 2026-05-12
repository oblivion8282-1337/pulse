<!--
  StreamTargetPicker — segmented toggle "Stream-Ziel: [Dieser Channel] | [Eigener Server]" (T4).

  Only renders the "Dieser Channel" option when a `channelId` is available
  (i.e. the panel was opened from a voice channel — the HqStreamDialog passes
  `voice.channelId` through). In the channel mode the server picker below is
  hidden; in the server mode the existing ProfilePicker/ServerPicker flow shows.

  Drives `streamSettings.target` ('channel' | 'server').
-->
<script lang="ts">
  import RadioTowerIcon from '@lucide/svelte/icons/radio-tower';
  import ServerIcon from '@lucide/svelte/icons/server';
  import { streamSettings, type StreamTarget } from '../settings.svelte';

  let { channelId = null }: { channelId?: string | null } = $props();

  function set(t: StreamTarget) {
    streamSettings.target = t;
  }

  const base =
    'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors';
  const active = 'bg-bg-input text-text-bright shadow-sm';
  const inactive = 'text-text-muted hover:text-text-base';
</script>

{#if channelId}
  <div class="flex flex-col gap-1.5" data-testid="stream-target-picker">
    <span class="text-text-muted text-xs font-medium">Stream-Ziel</span>
    <div class="bg-bg-chat flex gap-1 rounded-lg p-1">
      <button
        type="button"
        class="{base} {streamSettings.target === 'channel' ? active : inactive}"
        aria-pressed={streamSettings.target === 'channel'}
        onclick={() => set('channel')}
        data-testid="stream-target-channel"
      >
        <RadioTowerIcon class="size-3.5" />
        Dieser Channel
      </button>
      <button
        type="button"
        class="{base} {streamSettings.target === 'server' ? active : inactive}"
        aria-pressed={streamSettings.target === 'server'}
        onclick={() => set('server')}
        data-testid="stream-target-server"
      >
        <ServerIcon class="size-3.5" />
        Eigener Server
      </button>
    </div>
  </div>
{/if}
