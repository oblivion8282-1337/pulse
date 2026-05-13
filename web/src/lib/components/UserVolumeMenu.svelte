<script lang="ts">
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import VolumeXIcon from '@lucide/svelte/icons/volume-x';
  import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
  import { settings, USER_VOLUME_MAX } from '$lib/stores/settings.svelte';
  import { voice } from '$lib/voice/livekit.svelte';

  let { userId, name }: { userId: string; name: string } = $props();

  const SLIDER_MAX = USER_VOLUME_MAX * 100;
  let volumePct = $derived(Math.round(settings.getUserVolume(userId) * 100));

  function applyVolumePct(pct: number): void {
    const clamped = Math.max(0, Math.min(SLIDER_MAX, Math.round(pct)));
    const gain = clamped / 100;
    settings.setUserVolume(userId, gain);
    voice.setUserVolume(userId, gain);
  }
</script>

<ContextMenu.Content class="w-64" data-testid="voice-participant-context-menu">
  <ContextMenu.Label class="flex items-center gap-2 text-xs">
    {#if volumePct === 0}
      <VolumeXIcon class="size-3.5" />
    {:else}
      <Volume2Icon class="size-3.5" />
    {/if}
    <span class="flex-1 truncate">Lautstärke für {name}</span>
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
      aria-label={`Lautstärke für ${name}`}
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
