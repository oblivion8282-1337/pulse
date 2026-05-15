<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import MicIcon from '@lucide/svelte/icons/mic';
  import MicOffIcon from '@lucide/svelte/icons/mic-off';
  import HeadphonesIcon from '@lucide/svelte/icons/headphones';
  import HeadphoneOffIcon from '@lucide/svelte/icons/headphone-off';
  import PhoneOffIcon from '@lucide/svelte/icons/phone-off';
  import RadioIcon from '@lucide/svelte/icons/radio';
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import MonitorOffIcon from '@lucide/svelte/icons/monitor-off';
  import { toast } from 'svelte-sonner';
  import { voice } from '$lib/voice/livekit.svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import HqStreamButton from '$lib/stream/components/HqStreamButton.svelte';
  import WatchPartyStartButton from './WatchPartyStartButton.svelte';

  let hqStreamOpen = $state(false);

  async function handleScreenShare() {
    try {
      await voice.setScreenShare(!voice.isScreenSharing);
    } catch {
      toast.info('Bildschirm teilen abgebrochen');
    }
  }
</script>

<div
  class="border-border mx-1 mt-1 rounded-2xl border bg-bg-input/60 p-1.5"
  data-testid="voice-control-bar"
>
  <div class="flex items-center gap-1.5 px-1 pb-1.5 text-xs">
    <span
      class="size-2 shrink-0 rounded-full {voice.connecting ? 'bg-yellow-400' : 'bg-green-500'}"
      aria-hidden="true"
    ></span>
    <span class="text-text-muted shrink-0">
      {voice.connecting ? 'Verbinden' : 'Voice'}
    </span>
    {#if voice.channelName}
      <span class="text-text-bright truncate font-semibold" title={voice.channelName}>
        · {voice.channelName}
      </span>
    {/if}
  </div>

  <div class="flex items-center gap-0.5">
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant={voice.micEnabled ? 'secondary' : 'destructive'}
              size="icon-sm"
              onclick={() => voice.toggleMic()}
              data-testid="voice-mic-toggle"
              aria-label={voice.micEnabled ? 'Mikrofon stummschalten' : 'Mikrofon aktivieren'}
            >
              {#if voice.micEnabled}<MicIcon class="size-4" />{:else}<MicOffIcon class="size-4" />{/if}
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>{voice.micEnabled ? 'Mikrofon stumm' : 'Mikrofon an'}</Tooltip.Content>
      </Tooltip.Root>

      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant={voice.deafened ? 'destructive' : 'secondary'}
              size="icon-sm"
              onclick={() => voice.toggleDeafen()}
              data-testid="voice-deafen-toggle"
              aria-label={voice.deafened ? 'Ton aktivieren' : 'Ton stummschalten'}
            >
              {#if voice.deafened}<HeadphoneOffIcon class="size-4" />{:else}<HeadphonesIcon class="size-4" />{/if}
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>{voice.deafened ? 'Taub (alle stumm)' : 'Ton an'}</Tooltip.Content>
      </Tooltip.Root>

      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant={voice.pttMode ? 'default' : 'ghost'}
              size="icon-sm"
              onclick={() => voice.setPttMode(!voice.pttMode)}
              data-testid="voice-ptt-toggle"
              aria-label="Push-to-Talk umschalten"
            >
              <RadioIcon class="size-4" />
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>
          {voice.pttMode
            ? `Push-to-Talk an (Taste „${settings.voice.pttKey.toUpperCase()}" halten)`
            : 'Push-to-Talk aus'}
        </Tooltip.Content>
      </Tooltip.Root>

      {#if voice.channelId}
        <WatchPartyStartButton channelId={voice.channelId} />
      {/if}

      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant={voice.isScreenSharing ? 'default' : 'ghost'}
              size="icon-sm"
              onclick={handleScreenShare}
              data-testid="voice-screenshare-toggle"
              aria-label={voice.isScreenSharing ? 'Bildschirm teilen beenden' : 'Bildschirm teilen'}
            >
              {#if voice.isScreenSharing}<MonitorOffIcon class="size-4" />{:else}<MonitorIcon class="size-4" />{/if}
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>
          {voice.isScreenSharing ? 'Teilen beenden' : 'Bildschirm teilen'}
        </Tooltip.Content>
      </Tooltip.Root>

      <HqStreamButton bind:open={hqStreamOpen} compact />

      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="destructive"
              size="icon-sm"
              class="ml-auto"
              onclick={() => voice.disconnect({ reason: 'user' })}
              data-testid="voice-disconnect"
              aria-label="Voice verlassen"
            >
              <PhoneOffIcon class="size-4" />
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>Voice verlassen</Tooltip.Content>
      </Tooltip.Root>
    </Tooltip.Provider>
  </div>
</div>
