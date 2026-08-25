<!--
  Per-user volume slider + reset button. Used inside UserProfilePopover
  for voice-channel members (sidebar list and voice tiles). Pure body —
  no menu chrome — so the host (Popover.Content) controls layout and
  background.

  Range goes from 0 to USER_VOLUME_MAX*100 (default 200%) so users can
  boost a quiet member above their own LiveKit gain. Mobile caps at 100%:
  the `<audio>`-Element playback path there can't exceed 1.0 anyway
  (HTMLMediaElement.volume spec clamp) — a slider beyond 100% would
  promise a boost that never happens.
-->
<script lang="ts">
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import VolumeXIcon from '@lucide/svelte/icons/volume-x';
  import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
  import { settings, USER_VOLUME_MAX } from '$lib/stores/settings.svelte';
  import { voice } from '$lib/voice/livekit.svelte';
  import { isMobile } from '$lib/platform/runtime';
  import { m } from '$lib/paraglide/messages.js';
  import MenuRow from '$lib/components/menu/MenuRow.svelte';

  let { userId, name }: { userId: string; name: string } = $props();

  const SLIDER_MAX = isMobile() ? 100 : USER_VOLUME_MAX * 100;
  let volumePct = $derived(
    Math.min(SLIDER_MAX, Math.round(settings.getUserVolume(userId) * 100))
  );

  function applyVolumePct(pct: number): void {
    const clamped = Math.max(0, Math.min(SLIDER_MAX, Math.round(pct)));
    const gain = clamped / 100;
    settings.setUserVolume(userId, gain);
    voice.setUserVolume(userId, gain);
  }
</script>

<div class="border-border/40 border-t pt-3" data-testid="voice-volume-control">
  <div class="text-text-muted mb-2 flex items-center gap-2 text-xs">
    {#if volumePct === 0}
      <VolumeXIcon class="size-3.5" />
    {:else}
      <Volume2Icon class="size-3.5" />
    {/if}
    <span class="flex-1 truncate">{m.voice_user_volume_label({ name })}</span>
    <span class="font-mono">{volumePct}%</span>
  </div>
  <input
    type="range"
    min="0"
    max={SLIDER_MAX}
    step="5"
    value={volumePct}
    oninput={(e) => applyVolumePct(Number((e.currentTarget as HTMLInputElement).value))}
    class="w-full accent-emerald-500"
    aria-label={m.voice_user_volume_label({ name })}
    data-testid="voice-participant-volume-slider"
  />
  <MenuRow
    class="mt-2"
    disabled={volumePct === 100}
    onclick={() => applyVolumePct(100)}
    data-testid="voice-participant-volume-reset"
  >
    <RotateCcwIcon class="size-3.5" />
    {m.voice_user_volume_reset()}
  </MenuRow>
</div>
