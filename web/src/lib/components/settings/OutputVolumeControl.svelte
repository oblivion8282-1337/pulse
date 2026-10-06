<script lang="ts">
  import {
    settings,
    OUTPUT_VOLUME_MIN,
    OUTPUT_VOLUME_MAX
  } from '$lib/stores/settings.svelte';
  import { voice } from '$lib/voice/livekit.svelte';
  import { isMobile } from '$lib/platform/runtime';
  import { m } from '$lib/paraglide/messages.js';

  // Slider is integer percent (0..200 = 0.0..2.0×). Live-apply on drag
  // (cheap AudioParam / element.volume set), persist on release.
  const SLIDER_MIN = OUTPUT_VOLUME_MIN * 100;
  const SLIDER_MAX = OUTPUT_VOLUME_MAX * 100;
  // The mobile <audio> path can't exceed 100 % (HTMLMediaElement.volume cap).
  const mobile = isMobile();
  const sliderMax = mobile ? 100 : SLIDER_MAX;

  let volPctDisplay = $state(Math.round(settings.voice.outputVolume * 100));
  $effect(() => {
    volPctDisplay = Math.round(settings.voice.outputVolume * 100);
  });

  function sliderPct(e: Event): number | null {
    const pct = parseInt((e.currentTarget as HTMLInputElement).value, 10);
    return isNaN(pct) ? null : pct;
  }
  function onInput(e: Event) {
    const pct = sliderPct(e);
    if (pct === null) return;
    volPctDisplay = pct;
    voice.setOutputVolume(pct / 100);
  }
  function onChange(e: Event) {
    const pct = sliderPct(e);
    if (pct === null) return;
    settings.setOutputVolume(pct / 100);
  }
</script>

<div class="flex flex-col gap-2">
  <div class="flex items-center justify-between">
    <span class="text-text-base text-sm">{m.output_volume_control_label()}</span>
    <span class="text-text-muted text-sm font-mono">{volPctDisplay}%</span>
  </div>
  <input
    type="range"
    min={SLIDER_MIN}
    max={sliderMax}
    step="5"
    value={Math.min(volPctDisplay, sliderMax)}
    oninput={onInput}
    onchange={onChange}
    class="accent-primary h-3 w-full md:h-auto"
    data-testid="settings-output-volume"
  />
</div>
