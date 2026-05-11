<script lang="ts">
  import { untrack } from 'svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import VoiceParticipantTile from './VoiceParticipantTile.svelte';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import MicIcon from '@lucide/svelte/icons/mic';
  import MicOffIcon from '@lucide/svelte/icons/mic-off';
  import HeadphonesIcon from '@lucide/svelte/icons/headphones';
  import HeadphoneOffIcon from '@lucide/svelte/icons/headphone-off';
  import PhoneOffIcon from '@lucide/svelte/icons/phone-off';
  import RadioIcon from '@lucide/svelte/icons/radio';
  import { toast } from 'svelte-sonner';
  import { voice } from '$lib/voice/livekit.svelte';
  import { shortcut, type ShortcutEventDetail } from '@svelte-put/shortcut';
  import type { Channel } from '$lib/api/types';

  let { channel }: { channel: Channel } = $props();

  // Auto-connect once when this view first shows for a channel we're not
  // already in. We deliberately do NOT retry on failure (the user clicks
  // "Beitreten" instead) — that avoids a reactive connect-fail-connect loop.
  let autoConnectAttempted = false;

  async function joinChannel() {
    try {
      await voice.connect(channel.id, channel.name);
    } catch (e) {
      toast.error('Voice-Verbindung fehlgeschlagen', {
        description: e instanceof Error ? e.message : String(e)
      });
    }
  }

  $effect(() => {
    const cid = channel.id;
    const alreadyHere = voice.channelId === cid;
    const busy = voice.connecting;
    untrack(() => {
      if (!alreadyHere && !busy && !autoConnectAttempted) {
        autoConnectAttempted = true;
        void joinChannel();
      }
    });
  });

  let isThisChannel = $derived(voice.channelId === channel.id);
  let statusLabel = $derived(
    voice.connecting
      ? 'Verbinde…'
      : voice.connected
        ? `Sprach-Kanal · ${voice.participants.length} ${voice.participants.length === 1 ? 'Teilnehmer' : 'Teilnehmer'}`
        : voice.error
          ? `Fehler: ${voice.error}`
          : 'Nicht verbunden'
  );

  function isTypingTarget(el: EventTarget | null): boolean {
    if (!(el instanceof HTMLElement)) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
  }
  function handlePttKeydown(detail: ShortcutEventDetail) {
    const ev = detail.originalEvent;
    if (!voice.pttMode || ev.repeat || isTypingTarget(ev.target)) return;
    ev.preventDefault();
    voice.pttPress();
  }
  function handlePttKeyup(e: KeyboardEvent) {
    if (!voice.pttMode || (e.key !== 'v' && e.key !== 'V')) return;
    if (isTypingTarget(e.target)) return;
    voice.pttRelease();
  }
</script>

<svelte:window
  use:shortcut={{
    type: 'keydown',
    trigger: { key: 'v', modifier: false, callback: handlePttKeydown }
  }}
  onkeyup={handlePttKeyup}
  onblur={() => { if (voice.pttMode) voice.pttRelease(); }}
  onvisibilitychange={() => { if (document.visibilityState === 'hidden' && voice.pttMode) voice.pttRelease(); }}
/>

<section class="bg-bg-chat flex h-full min-w-0 flex-1 flex-col" data-testid="voice-channel-view">
  <header class="flex h-12 items-center gap-2 border-b border-black/30 px-4 shadow-sm">
    <Volume2Icon class="text-text-muted size-5" />
    <span class="text-text-bright font-semibold" data-testid="active-channel-name">{channel.name}</span>
    <span class="text-text-muted ml-3 text-sm">{statusLabel}</span>
  </header>

  <div class="flex flex-1 flex-col items-center justify-center gap-8 p-8">
    {#if isThisChannel && (voice.connected || voice.connecting)}
      {#if voice.participants.length === 0}
        <p class="text-text-muted text-sm">Verbinde mit dem Sprach-Kanal…</p>
      {:else}
        <div class="flex flex-wrap items-start justify-center gap-6" data-testid="voice-participants">
          {#each voice.participants as p (p.identity)}
            <VoiceParticipantTile {p} />
          {/each}
        </div>
      {/if}
    {:else}
      <div class="text-center">
        <Volume2Icon class="text-text-muted mx-auto mb-3 size-12" />
        <p class="text-text-bright mb-1 text-lg">{channel.name}</p>
        <p class="text-text-muted text-sm">Klicke „Beitreten“, um dem Sprach-Kanal beizutreten.</p>
        {#if voice.error}
          <p class="mt-2 text-sm text-red-400">{voice.error}</p>
        {/if}
        <Button class="mt-4" onclick={joinChannel} data-testid="voice-join">Beitreten</Button>
      </div>
    {/if}
  </div>

  {#if isThisChannel && (voice.connected || voice.connecting)}
    <Separator />
    <!-- pr-28: keep clear of the fixed sign-out button in the bottom-right. -->
    <div class="flex items-center justify-between gap-3 px-4 py-3 pr-28">
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
                  size="icon"
                  onclick={() => voice.setPttMode(!voice.pttMode)}
                  data-testid="voice-ptt-toggle"
                  aria-label="Push-to-Talk umschalten"
                >
                  <RadioIcon />
                </Button>
              {/snippet}
            </Tooltip.Trigger>
            <Tooltip.Content>
              {voice.pttMode ? 'Push-to-Talk an (Taste „V“ halten)' : 'Push-to-Talk aus (offenes Mikro)'}
            </Tooltip.Content>
          </Tooltip.Root>
        </Tooltip.Provider>

        {#if voice.outputDevices.length > 1}
          <select
            class="bg-bg-input text-text-base h-9 rounded-md px-2 text-sm outline-none"
            value={voice.selectedOutputDeviceId}
            onchange={(e) => voice.setOutputDevice((e.currentTarget as HTMLSelectElement).value)}
            data-testid="voice-output-device"
            aria-label="Audio-Ausgabegerät"
          >
            {#each voice.outputDevices as d (d.deviceId)}
              <option value={d.deviceId}>{d.label || `Ausgabegerät ${d.deviceId.slice(0, 6)}`}</option>
            {/each}
          </select>
        {/if}
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
  {/if}
</section>
