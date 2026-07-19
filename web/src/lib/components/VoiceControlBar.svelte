<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import MicIcon from '@lucide/svelte/icons/mic';
  import MicOffIcon from '@lucide/svelte/icons/mic-off';
  import ShieldIcon from '@lucide/svelte/icons/shield';
  import HeadphonesIcon from '@lucide/svelte/icons/headphones';
  import HeadphoneOffIcon from '@lucide/svelte/icons/headphone-off';
  import PhoneOffIcon from '@lucide/svelte/icons/phone-off';
  import VideoIcon from '@lucide/svelte/icons/video';
  import VideoOffIcon from '@lucide/svelte/icons/video-off';
  import SwitchCameraIcon from '@lucide/svelte/icons/switch-camera';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import EarIcon from '@lucide/svelte/icons/ear';
  import { toast } from 'svelte-sonner';
  import { voice } from '$lib/voice/livekit.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { channelPermissions } from '$lib/stores/channelPermissions.svelte';
  import { voicePresence } from '$lib/stores/voicePresence.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { Perm } from '$lib/permissions/bitfield';
  import ScreenShareModeButton from './ScreenShareModeButton.svelte';
  import WatchPartyStartButton from './WatchPartyStartButton.svelte';
  import StreamStatusBar from '$lib/stream/components/StreamStatusBar.svelte';
  import { onMount } from 'svelte';
  import { isCapacitorAndroid } from '$lib/platform/runtime';
  import { setAudioRoute, getAudioRoute } from '$lib/platform/audioRoute';

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
    const guildId = guilds.guildIdForChannel(cid);
    if (!guildId) return true;
    return channelPermissions.hasChannelPermission(guildId, cid, Perm.USE_VIDEO);
  });

  // Front/back camera flip only makes sense on touch devices (phones/tablets)
  // with two cameras. On desktop — the Electron app or a desktop browser, both
  // mouse-driven — there's no facingMode to toggle, so the button is noise.
  // `pointer: coarse` is true for touch as the primary pointer, false for mouse,
  // regardless of window width (unlike a viewport breakpoint).
  const isTouchDevice =
    typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

  // Gemeinsamer Basiswert für Force-Mute/Deafen-Ableitungen.
  const selfContext = $derived.by(() => {
    const cid = voice.channelId;
    const uid = currentServerUserId();
    return cid && uid ? { cid, uid } : null;
  });

  // Force-mute state for the local user in the current voice channel.
  // The LiveKit token already prevents publish; this flag is purely for
  // disabling the mic-toggle UI + showing the right tooltip so the user
  // sees *why* their mic is locked instead of an opaque silent failure.
  let selfForceMuted = $derived(
    selfContext ? voicePresence.isForceMuted(selfContext.cid, selfContext.uid) : false
  );
  // Server force-deafen: voice.setDeafened is driven from the WS event
  // handler; this flag just disables the toggle so the user can't undeafen
  // themselves until the override is cleared.
  let selfForceDeafened = $derived(
    selfContext ? voicePresence.isForceDeafened(selfContext.cid, selfContext.uid) : false
  );

  // Manueller Lautsprecher/Hörmuschel-Umschalter — nur in der Android-App
  // (ruft das native AudioRoute-Plugin). Im Browser/Electron unsichtbar/No-op.
  // Default = Lautsprecher (= nativer Auto-Modus); Tippen erzwingt Hörmuschel
  // bzw. zurück. Onmount mit dem nativen Stand synchronisieren.
  const showAudioRouteToggle = isCapacitorAndroid();
  let speakerOn = $state(true);
  onMount(() => {
    if (!showAudioRouteToggle) return;
    void getAudioRoute().then((r) => {
      speakerOn = r !== 'earpiece';
    });
  });
  function toggleAudioRoute(): void {
    speakerOn = !speakerOn;
    void setAudioRoute(speakerOn ? 'speaker' : 'earpiece');
  }

  const btnCls = 'size-14 md:size-8';
  const iconCls = 'size-6 md:size-4';
</script>

<StreamStatusBar />

<div
  class="border-border mx-2 mt-2 rounded-2xl border bg-bg-input/60 p-2 md:p-1.5"
  data-testid="voice-control-bar"
>
  <div class="flex items-center gap-1.5 px-1 pb-1.5 text-base md:text-xs">
    <span
      class="size-2 shrink-0 rounded-full {voice.connecting ? 'bg-warning' : 'bg-success'}"
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
              class="{btnCls} relative"
              onclick={() => voice.toggleMic()}
              disabled={selfForceMuted}
              data-testid="voice-mic-toggle"
              aria-label={selfForceMuted
                ? 'Vom Mod stummgeschaltet'
                : voice.micEnabled
                  ? 'Mikrofon stummschalten'
                  : 'Mikrofon aktivieren'}
            >
              {#if voice.micEnabled && !selfForceMuted}<MicIcon class={iconCls} />{:else}<MicOffIcon class={iconCls} />{/if}
              {#if selfForceMuted}
                <ShieldIcon
                  class="absolute right-0.5 bottom-0.5 size-3 fill-amber-400 stroke-bg-input stroke-[2.5]"
                  aria-hidden="true"
                />
              {/if}
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
              class="{btnCls} relative"
              onclick={() => voice.toggleDeafen()}
              disabled={selfForceDeafened}
              data-testid="voice-deafen-toggle"
              aria-label={selfForceDeafened
                ? 'Vom Mod taubgeschaltet'
                : voice.deafened
                  ? 'Ton aktivieren'
                  : 'Ton stummschalten'}
            >
              {#if voice.deafened}<HeadphoneOffIcon class={iconCls} />{:else}<HeadphonesIcon class={iconCls} />{/if}
              {#if selfForceDeafened}
                <ShieldIcon
                  class="absolute right-0.5 bottom-0.5 size-3 fill-amber-400 stroke-bg-input stroke-[2.5]"
                  aria-hidden="true"
                />
              {/if}
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

      <!-- Lautsprecher/Hörmuschel-Umschalter — nur in der Android-App (nativer
           AudioRoute-Toggle). Behebt den earpiece-Default im Kommunikationsmodus. -->
      {#if showAudioRouteToggle}
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <Button
                {...props}
                variant={speakerOn ? 'default' : 'ghost'}
                size="icon-sm"
                class={btnCls}
                onclick={toggleAudioRoute}
                data-testid="voice-audio-route-toggle"
                aria-label={speakerOn ? 'Auf Hörmuschel umschalten' : 'Auf Lautsprecher umschalten'}
              >
                {#if speakerOn}<Volume2Icon class={iconCls} />{:else}<EarIcon class={iconCls} />{/if}
              </Button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content>
            {speakerOn ? 'Lautsprecher (tippen für Hörmuschel)' : 'Hörmuschel (tippen für Lautsprecher)'}
          </Tooltip.Content>
        </Tooltip.Root>
      {/if}

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
                class={btnCls}
                onclick={() => voice.toggleCamera()}
                data-testid="voice-camera-toggle"
                aria-label={voice.isCameraOn ? 'Kamera ausschalten' : 'Kamera einschalten'}
              >
                {#if voice.isCameraOn}<VideoIcon class={iconCls} />{:else}<VideoOffIcon class={iconCls} />{/if}
              </Button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content>
            {voice.isCameraOn ? 'Kamera aus' : 'Kamera an'}
          </Tooltip.Content>
        </Tooltip.Root>

        <!-- Front-/Rückkamera umschalten — nur auf Touch-Geräten (Handy/Tablet)
             mit zwei Kameras; auf Desktop (App/Browser) sinnlos. -->
        {#if voice.isCameraOn && isTouchDevice}
          <Tooltip.Root>
            <Tooltip.Trigger>
              {#snippet child({ props })}
                <Button
                  {...props}
                  variant="ghost"
                  size="icon-sm"
                  class={btnCls}
                  onclick={() => voice.flipCamera()}
                  data-testid="voice-camera-flip"
                  aria-label="Kamera wechseln"
                >
                  <SwitchCameraIcon class={iconCls} />
                </Button>
              {/snippet}
            </Tooltip.Trigger>
            <Tooltip.Content>Kamera wechseln (Front/Rück)</Tooltip.Content>
          </Tooltip.Root>
        {/if}
      {/if}

      <!-- Screenshare/HQ — auf Mobil ausgeblendet (kein getDisplayMedia auf iOS/Android) -->
      {#if !viewport.isMobile}
        <ScreenShareModeButton />
      {/if}

      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="destructive"
              size="icon-sm"
              class="ml-auto max-md:ml-0 {btnCls}"
              onclick={() => voice.disconnect({ reason: 'user' })}
              data-testid="voice-disconnect"
              aria-label="Voice verlassen"
            >
              <PhoneOffIcon class={iconCls} />
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>Voice verlassen</Tooltip.Content>
      </Tooltip.Root>
    </Tooltip.Provider>
  </div>
</div>
