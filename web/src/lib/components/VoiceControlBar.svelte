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

  let hqStreamOpen = $state(false);

  async function handleScreenShare() {
    try {
      await voice.setScreenShare(!voice.isScreenSharing);
    } catch {
      toast.info('Bildschirm teilen abgebrochen');
    }
  }
</script>

<div class="flex items-center justify-between gap-3 px-4 py-3">
  <div class="flex items-center gap-2">
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant={voice.micEnabled ? 'secondary' : 'destructive'}
              size="icon"
              onclick={() => voice.toggleMic()}
              data-testid="voice-mic-toggle"
              aria-label={voice.micEnabled ? 'Mikrofon stummschalten' : 'Mikrofon aktivieren'}
            >
              {#if voice.micEnabled}<MicIcon />{:else}<MicOffIcon />{/if}
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
              size="icon"
              onclick={() => voice.toggleDeafen()}
              data-testid="voice-deafen-toggle"
              aria-label={voice.deafened ? 'Ton aktivieren' : 'Ton stummschalten'}
            >
              {#if voice.deafened}<HeadphoneOffIcon />{:else}<HeadphonesIcon />{/if}
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
              size={'icon' as const}
              onclick={() => voice.setPttMode(!voice.pttMode)}
              data-testid="voice-ptt-toggle"
              aria-label="Push-to-Talk umschalten"
            >
              <RadioIcon />
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>
          {voice.pttMode
            ? `Push-to-Talk an (Taste „${settings.voice.pttKey.toUpperCase()}" halten)`
            : 'Push-to-Talk aus (offenes Mikro)'}
        </Tooltip.Content>
      </Tooltip.Root>
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant={voice.isScreenSharing ? 'default' : 'ghost'}
              size={'icon' as const}
              onclick={handleScreenShare}
              data-testid="voice-screenshare-toggle"
              aria-label={voice.isScreenSharing ? 'Bildschirm teilen beenden' : 'Bildschirm teilen'}
            >
              {#if voice.isScreenSharing}<MonitorOffIcon />{:else}<MonitorIcon />{/if}
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>
          {voice.isScreenSharing ? 'Teilen beenden' : 'Bildschirm teilen'}
        </Tooltip.Content>
      </Tooltip.Root>
    </Tooltip.Provider>
    <HqStreamButton bind:open={hqStreamOpen} />
  </div>

  <Button
    variant="destructive"
    size="sm"
    class="gap-1.5"
    onclick={() => voice.disconnect()}
    data-testid="voice-disconnect"
  >
    <PhoneOffIcon class="size-4" />
    Verlassen
  </Button>
</div>
