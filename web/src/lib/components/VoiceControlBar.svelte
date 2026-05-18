<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import MicIcon from '@lucide/svelte/icons/mic';
  import MicOffIcon from '@lucide/svelte/icons/mic-off';
  import HeadphonesIcon from '@lucide/svelte/icons/headphones';
  import HeadphoneOffIcon from '@lucide/svelte/icons/headphone-off';
  import PhoneOffIcon from '@lucide/svelte/icons/phone-off';
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import MonitorOffIcon from '@lucide/svelte/icons/monitor-off';
  import VideoIcon from '@lucide/svelte/icons/video';
  import VideoOffIcon from '@lucide/svelte/icons/video-off';
  import { toast } from 'svelte-sonner';
  import { voice } from '$lib/voice/livekit.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { channelPermissions } from '$lib/stores/channelPermissions.svelte';
  import { Perm } from '$lib/permissions/bitfield';
  import HqStreamButton from '$lib/stream/components/HqStreamButton.svelte';
  import WatchPartyStartButton from './WatchPartyStartButton.svelte';

  let hqStreamOpen = $state(false);

  // Camera-toggle gate: same shape as the HQ-stream button. Hide when
  // the channel's resolved permissions lack USE_VIDEO. Falls back to
  // "allowed" if the channel isn't in the local guild store yet
  // (matches the optimistic-ungated default elsewhere). Note: this is
  // a UI-only gate — voice-signaling currently grants ``can_publish``
  // unconditionally in the LiveKit token, so a determined user could
  // still publish video via DevTools. A backend gate via
  // ``can_publish_sources`` is the proper follow-up.
  let canUseCamera = $derived.by(() => {
    const cid = voice.channelId;
    if (!cid) return true;
    const ch = Object.values(guilds.channelsByGuild)
      .flat()
      .find((c) => c.id === cid);
    if (!ch) return true;
    return channelPermissions.hasChannelPermission(ch.guild_id, ch.id, Perm.USE_VIDEO);
  });

  async function handleScreenShare() {
    try {
      await voice.setScreenShare(!voice.isScreenSharing);
    } catch {
      toast.info('Bildschirm teilen abgebrochen');
    }
  }
</script>

<div
  class="border-border mx-2 mt-2 rounded-2xl border bg-bg-input/60 p-1.5"
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

      {#if voice.channelId}
        <WatchPartyStartButton channelId={voice.channelId} />
      {/if}

      {#if canUseCamera}
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <Button
                {...props}
                variant={voice.isCameraOn ? 'default' : 'ghost'}
                size="icon-sm"
                onclick={() => voice.toggleCamera()}
                data-testid="voice-camera-toggle"
                aria-label={voice.isCameraOn ? 'Kamera ausschalten' : 'Kamera einschalten'}
              >
                {#if voice.isCameraOn}<VideoIcon class="size-4" />{:else}<VideoOffIcon class="size-4" />{/if}
              </Button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content>
            {voice.isCameraOn ? 'Kamera aus' : 'Kamera an'}
          </Tooltip.Content>
        </Tooltip.Root>
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
