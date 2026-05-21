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
  import { voicePresence } from '$lib/stores/voicePresence.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { Perm } from '$lib/permissions/bitfield';
  import HqStreamButton from '$lib/stream/components/HqStreamButton.svelte';
  import ScreenSharePublishStats from './ScreenSharePublishStats.svelte';
  import WatchPartyStartButton from './WatchPartyStartButton.svelte';
  import type { PublishStats } from '$lib/voice/screenShareStats';

  let publishStats = $state<PublishStats | null>(null);

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

  // Force-mute state for the local user in the current voice channel.
  // The LiveKit token already prevents publish; this flag is purely for
  // disabling the mic-toggle UI + showing the right tooltip so the user
  // sees *why* their mic is locked instead of an opaque silent failure.
  let selfForceMuted = $derived.by(() => {
    const cid = voice.channelId;
    const uid = auth.user?.id;
    if (!cid || !uid) return false;
    return voicePresence.isForceMuted(cid, uid);
  });
  // Server force-deafen: voice.setDeafened is driven from the WS event
  // handler; this flag just disables the toggle so the user can't undeafen
  // themselves until the override is cleared.
  let selfForceDeafened = $derived.by(() => {
    const cid = voice.channelId;
    const uid = auth.user?.id;
    if (!cid || !uid) return false;
    return voicePresence.isForceDeafened(cid, uid);
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
  class="border-border mx-2 mt-2 rounded-2xl border bg-bg-input/60 p-2 md:p-1.5"
  data-testid="voice-control-bar"
>
  <div class="flex items-center gap-1.5 px-1 pb-1.5 text-base md:text-xs">
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

  <div class="flex flex-wrap items-center justify-around gap-2 md:justify-start md:gap-1">
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant={voice.micEnabled && !selfForceMuted ? 'secondary' : 'destructive'}
              size="icon-sm"
              class="size-14 md:size-8"
              onclick={() => voice.toggleMic()}
              disabled={selfForceMuted}
              data-testid="voice-mic-toggle"
              aria-label={selfForceMuted
                ? 'Vom Mod stummgeschaltet'
                : voice.micEnabled
                  ? 'Mikrofon stummschalten'
                  : 'Mikrofon aktivieren'}
            >
              {#if voice.micEnabled && !selfForceMuted}<MicIcon class="size-6 md:size-4" />{:else}<MicOffIcon class="size-6 md:size-4" />{/if}
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>
          {#if selfForceMuted}
            Vom Mod stummgeschaltet
          {:else}
            {voice.micEnabled ? 'Mikrofon stumm' : 'Mikrofon an'}
          {/if}
        </Tooltip.Content>
      </Tooltip.Root>

      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant={voice.deafened ? 'destructive' : 'secondary'}
              size="icon-sm"
              class="size-14 md:size-8"
              onclick={() => voice.toggleDeafen()}
              disabled={selfForceDeafened}
              data-testid="voice-deafen-toggle"
              aria-label={selfForceDeafened
                ? 'Vom Mod taubgeschaltet'
                : voice.deafened
                  ? 'Ton aktivieren'
                  : 'Ton stummschalten'}
            >
              {#if voice.deafened}<HeadphoneOffIcon class="size-6 md:size-4" />{:else}<HeadphonesIcon class="size-6 md:size-4" />{/if}
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>
          {#if selfForceDeafened}
            Vom Mod taubgeschaltet
          {:else}
            {voice.deafened ? 'Taub (alle stumm)' : 'Ton an'}
          {/if}
        </Tooltip.Content>
      </Tooltip.Root>

      <!-- Watch-Party auf Mobil ausgeblendet — Desktop-Feature (s. Phase 6). -->
      {#if voice.channelId && !viewport.isMobile}
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
                class="size-14 md:size-8"
                onclick={() => voice.toggleCamera()}
                data-testid="voice-camera-toggle"
                aria-label={voice.isCameraOn ? 'Kamera ausschalten' : 'Kamera einschalten'}
              >
                {#if voice.isCameraOn}<VideoIcon class="size-6 md:size-4" />{:else}<VideoOffIcon class="size-6 md:size-4" />{/if}
              </Button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content>
            {voice.isCameraOn ? 'Kamera aus' : 'Kamera an'}
          </Tooltip.Content>
        </Tooltip.Root>
      {/if}

      <!-- Bildschirm teilen auf Mobil ausgeblendet: getDisplayMedia() gibt's
           weder auf iOS Safari noch auf Android Chrome → toter Button. -->
      {#if !viewport.isMobile}
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <span class="relative inline-flex">
              <Button
                {...props}
                variant={voice.isScreenSharing ? 'default' : 'ghost'}
                size="icon-sm"
                class="size-14 md:size-8"
                onclick={handleScreenShare}
                data-testid="voice-screenshare-toggle"
                aria-label={voice.isScreenSharing ? 'Bildschirm teilen beenden' : 'Bildschirm teilen'}
              >
                {#if voice.isScreenSharing}<MonitorOffIcon class="size-6 md:size-4" />{:else}<MonitorIcon class="size-6 md:size-4" />{/if}
              </Button>
              <ScreenSharePublishStats bind:stats={publishStats} />
            </span>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>
          <div>{voice.isScreenSharing ? 'Teilen beenden' : 'Bildschirm teilen'}</div>
          {#if voice.isScreenSharing && publishStats}
            <div class="text-text-muted mt-1 space-y-0.5 border-t border-border pt-1 text-[11px] tabular-nums">
              <div>
                Encoder:
                {publishStats.encoderImpl || '—'}
                {#if publishStats.encoderKind === 'gpu'}
                  <span class="text-emerald-400">(GPU)</span>
                {:else if publishStats.encoderKind === 'cpu'}
                  <span class="text-amber-400">(CPU)</span>
                {/if}
              </div>
              <div>Codec: {publishStats.codec}</div>
              <div>Auflösung: {publishStats.res}</div>
              <div>FPS: {publishStats.fps}</div>
              <div>Bitrate: {publishStats.bitrate}</div>
            </div>
          {/if}
        </Tooltip.Content>
      </Tooltip.Root>
      {/if}

      <HqStreamButton compact />

      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="destructive"
              size="icon-sm"
              class="ml-auto max-md:ml-0 size-14 md:size-8"
              onclick={() => voice.disconnect({ reason: 'user' })}
              data-testid="voice-disconnect"
              aria-label="Voice verlassen"
            >
              <PhoneOffIcon class="size-6 md:size-4" />
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>Voice verlassen</Tooltip.Content>
      </Tooltip.Root>
    </Tooltip.Provider>
  </div>
</div>
