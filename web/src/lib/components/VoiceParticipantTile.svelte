<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import MicOffIcon from '@lucide/svelte/icons/mic-off';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import VolumeXIcon from '@lucide/svelte/icons/volume-x';
  import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
  import type { VoiceParticipant } from '$lib/voice/livekit.svelte';
  import { voice } from '$lib/voice/livekit.svelte';
  import { settings, USER_VOLUME_MAX } from '$lib/stores/settings.svelte';

  let { p }: { p: VoiceParticipant } = $props();

  let glow = $derived(p.isSpeaking ? Math.min(1, 0.35 + p.audioLevel * 2) : 0);
  let initial = $derived((p.name.trim()[0] ?? '?').toUpperCase());

  // Slider is in percent (0..400). Mirrors the persisted gain (0..4.0).
  // Reading via a $derived means the slider snaps back to the stored value
  // when another tab/tile changes it, and shows the default (100%) for
  // first-time interaction.
  const SLIDER_MAX = USER_VOLUME_MAX * 100; // 400
  let volumePct = $derived(
    p.userId ? Math.round(settings.getUserVolume(p.userId) * 100) : 100
  );
  let canAdjustVolume = $derived(!p.isLocal && p.userId !== null);

  function applyVolumePct(pct: number): void {
    if (!p.userId) return;
    const clamped = Math.max(0, Math.min(SLIDER_MAX, Math.round(pct)));
    const gain = clamped / 100;
    settings.setUserVolume(p.userId, gain);
    voice.setUserVolume(p.userId, gain);
  }
</script>

<ContextMenu.Root>
  <ContextMenu.Trigger>
    {#snippet child({ props })}
      <div
        {...props}
        class="glass-panel flex flex-col items-center gap-3 rounded-2xl px-6 py-5 transition-colors"
        data-testid="voice-participant"
        data-identity={p.identity}
      >
        <div class="relative">
          {#if glow > 0}
            <div
              class="accent-gradient absolute -inset-1.5 rounded-full blur-[3px]"
              style={`opacity: ${0.35 + glow * 0.5};`}
            ></div>
          {/if}
          <Avatar.Root class="relative size-20">
            <Avatar.Fallback class="accent-gradient text-primary-foreground text-xl font-semibold">
              {initial}
            </Avatar.Fallback>
          </Avatar.Root>
        </div>
        <div class="flex items-center gap-1 text-xs">
          <span class="text-text-bright max-w-28 truncate font-semibold" title={p.name}>
            {p.name}{p.isLocal ? ' (du)' : ''}
          </span>
          {#if p.micMuted}
            <MicOffIcon class="size-3 text-red-400" />
          {/if}
          {#if canAdjustVolume && volumePct !== 100}
            <span
              class="text-text-muted ml-1 font-mono text-[10px]"
              title="Eingestellte Lautstärke"
              data-testid="voice-participant-volume-badge"
            >
              {volumePct}%
            </span>
          {/if}
        </div>
      </div>
    {/snippet}
  </ContextMenu.Trigger>

  {#if canAdjustVolume}
    <ContextMenu.Content class="w-64" data-testid="voice-participant-context-menu">
      <ContextMenu.Label class="flex items-center gap-2 text-xs">
        {#if volumePct === 0}
          <VolumeXIcon class="size-3.5" />
        {:else}
          <Volume2Icon class="size-3.5" />
        {/if}
        <span class="flex-1 truncate">Lautstärke für {p.name}</span>
        <span class="font-mono">{volumePct}%</span>
      </ContextMenu.Label>
      <div class="px-2 py-1.5">
        <input
          type="range"
          min="0"
          max={SLIDER_MAX}
          step="5"
          value={volumePct}
          oninput={(e) => applyVolumePct(Number((e.currentTarget as HTMLInputElement).value))}
          class="w-full accent-emerald-500"
          aria-label={`Lautstärke für ${p.name}`}
          data-testid="voice-participant-volume-slider"
        />
        <div class="text-text-muted mt-1 flex justify-between font-mono text-[10px]">
          <span>0%</span>
          <span class="opacity-60">100%</span>
          <span>{SLIDER_MAX}%</span>
        </div>
      </div>
      <ContextMenu.Separator />
      <ContextMenu.Item
        disabled={volumePct === 100}
        onSelect={() => applyVolumePct(100)}
        data-testid="voice-participant-volume-reset"
      >
        <RotateCcwIcon class="size-3.5" />
        Standard (100%)
      </ContextMenu.Item>
    </ContextMenu.Content>
  {/if}
</ContextMenu.Root>
