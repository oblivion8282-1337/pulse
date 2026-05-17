<script lang="ts">
  import {
    settings,
    INPUT_MAKEUP_MIN,
    INPUT_MAKEUP_MAX
  } from '$lib/stores/settings.svelte';
  import { voice } from '$lib/voice/livekit.svelte';

  // Slider is integer percent (50..400 = 0.5..4.0×). Live-apply on drag via
  // voice.setInputMakeupGain (cheap AudioParam set), persist on release plus
  // a re-evaluate so the processor installs/uninstalls when crossing 1.0×.
  const SLIDER_MIN = INPUT_MAKEUP_MIN * 100;
  const SLIDER_MAX = INPUT_MAKEUP_MAX * 100;
  let gainPctDisplay = $state(Math.round(settings.audio.inputMakeupGain * 100));
  $effect(() => {
    gainPctDisplay = Math.round(settings.audio.inputMakeupGain * 100);
  });

  function onInput(e: Event) {
    const pct = parseInt((e.currentTarget as HTMLInputElement).value, 10);
    if (isNaN(pct)) return;
    gainPctDisplay = pct;
    voice.setInputMakeupGain(pct / 100);
  }
  function onChange(e: Event) {
    const pct = parseInt((e.currentTarget as HTMLInputElement).value, 10);
    if (isNaN(pct)) return;
    settings.setInputMakeupGain(pct / 100);
    if (voice.connected) void voice.applyNoiseFilter();
  }
  function reset() {
    gainPctDisplay = 100;
    settings.setInputMakeupGain(1);
    voice.setInputMakeupGain(1);
    if (voice.connected) void voice.applyNoiseFilter();
  }

  let dbLabel = $derived(
    gainPctDisplay === 100
      ? '0 dB'
      : `${gainPctDisplay > 100 ? '+' : ''}${(20 * Math.log10(gainPctDisplay / 100)).toFixed(1)} dB`
  );
  // Send-level meter: RMS bar + peak-hold line. RMS is smoothed; peak is what
  // the clip lamp actually reacts to (speech crest factor ~12–18 dB).
  let sendLevelPct = $derived(Math.round(voice.localSendLevel * 100));
  let sendPeakPct = $derived(Math.round(voice.localSendPeak * 100));
</script>

<div class="flex flex-col gap-2">
  <div class="flex items-center justify-between">
    <span class="text-text-bright text-sm font-medium">Mic-Verstärkung (Sender)</span>
    <span class="text-text-muted text-sm font-mono">
      {gainPctDisplay}% · {dbLabel}
    </span>
  </div>
  <input
    type="range"
    min={SLIDER_MIN}
    max={SLIDER_MAX}
    step="5"
    value={gainPctDisplay}
    oninput={onInput}
    onchange={onChange}
    class="accent-primary w-full"
    data-testid="settings-input-makeup"
  />
  <div class="flex items-center gap-2 text-text-muted text-xs">
    <span class="font-mono">{SLIDER_MIN}%</span>
    <span class="flex-1 text-center opacity-60">100%</span>
    <span class="font-mono">{SLIDER_MAX}%</span>
    <button
      type="button"
      onclick={reset}
      class="hover:text-text-base text-xs underline-offset-2 hover:underline"
      disabled={gainPctDisplay === 100}
      class:opacity-30={gainPctDisplay === 100}
      aria-label="Auf 100% zurücksetzen"
    >
      reset
    </button>
  </div>

  <!-- Sende-Pegel-Meter: post-Gate, post-Gain. Was andere tatsächlich hören. -->
  <div class="mt-1 flex items-center gap-2">
    <span class="text-text-muted text-xs w-20 shrink-0">Sende-Pegel</span>
    <div class="bg-bg-input relative h-2 flex-1 overflow-hidden rounded-full">
      <!-- RMS-Füllung: glatter Durchschnittspegel. -->
      <div
        class="absolute inset-y-0 left-0 transition-[width] duration-75"
        style:width="{sendLevelPct}%"
        class:bg-emerald-500={!voice.localSendClip}
        class:bg-red-500={voice.localSendClip}
      ></div>
      <!-- Peak-Hold-Line: zeigt die lauteste Spitze der letzten ~800 ms. Das ist
           was das Clip-Lämpchen tatsächlich auslöst (Sprache: Peak ≈ RMS + 12–18 dB). -->
      <div
        class="pointer-events-none absolute inset-y-0 w-px transition-[left] duration-75"
        style:left="{sendPeakPct}%"
        class:bg-white={!voice.localSendClip}
        class:bg-red-200={voice.localSendClip}
      ></div>
    </div>
    <span
      class="size-3 shrink-0 rounded-full transition-colors"
      class:bg-red-500={voice.localSendClip}
      class:bg-bg-input={!voice.localSendClip}
      class:shadow-[0_0_6px_rgb(239_68_68)]={voice.localSendClip}
      aria-label={voice.localSendClip ? 'Clipping!' : 'Kein Clipping'}
      title={voice.localSendClip ? 'Clipping — Pegel reduzieren' : ''}
    ></span>
  </div>
  <p class="text-text-muted text-xs leading-relaxed">
    Verstärkt deine eigene Stimme nach dem Noise-Filter, bevor sie an die anderen geschickt wird.
    Bei aktivem Clipping (rotes Lämpchen) den Regler reduzieren.
  </p>
</div>
