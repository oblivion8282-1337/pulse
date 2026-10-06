<script lang="ts">
  import {
    settings,
    INPUT_MAKEUP_MIN,
    INPUT_MAKEUP_MAX
  } from '$lib/stores/settings.svelte';
  import { voice } from '$lib/voice/livekit.svelte';
  import { micTest } from '$lib/voice/micTest.svelte';
  import { m } from '$lib/paraglide/messages.js';

  // Slider is integer percent (10..800 = 0.1..8.0×). Live-apply on drag via
  // voice.setInputMakeupGain (cheap AudioParam set), persist on release plus
  // a re-evaluate so the processor installs/uninstalls when crossing 1.0×.
  const SLIDER_MIN = INPUT_MAKEUP_MIN * 100;
  const SLIDER_MAX = INPUT_MAKEUP_MAX * 100;
  let gainPctDisplay = $state(Math.round(settings.audio.inputMakeupGain * 100));
  $effect(() => {
    gainPctDisplay = Math.round(settings.audio.inputMakeupGain * 100);
  });

  // Live-apply to the active source: the voice processor when connected, else
  // the settings-panel mic test — so the send meter + loopback react either way.
  function applyLive(gain: number) {
    voice.setInputMakeupGain(gain);
    micTest.setMakeup(gain);
  }
  function sliderPct(e: Event): number | null {
    const pct = parseInt((e.currentTarget as HTMLInputElement).value, 10);
    return isNaN(pct) ? null : pct;
  }
  function onInput(e: Event) {
    const pct = sliderPct(e);
    if (pct === null) return;
    gainPctDisplay = pct;
    applyLive(pct / 100);
  }
  function onChange(e: Event) {
    const pct = sliderPct(e);
    if (pct === null) return;
    settings.setInputMakeupGain(pct / 100);
    if (voice.connected) void voice.applyNoiseFilter();
  }

  let dbLabel = $derived(
    gainPctDisplay === 100
      ? '0 dB'
      : `${gainPctDisplay > 100 ? '+' : ''}${(20 * Math.log10(gainPctDisplay / 100)).toFixed(1)} dB`
  );
  // Send-level meter: RMS bar + peak-hold line. RMS is smoothed; peak is what
  // the clip lamp actually reacts to (speech crest factor ~12–18 dB). Reads the
  // live channel when connected, else the standalone mic test.
  let sendClip = $derived(voice.connected ? voice.localSendClip : micTest.sendClip);
  let sendLevelPct = $derived(Math.round((voice.connected ? voice.localSendLevel : micTest.sendLevel) * 100));
  let sendPeakPct = $derived(Math.round((voice.connected ? voice.localSendPeak : micTest.sendPeak) * 100));
</script>

<div class="flex flex-col gap-2">
  <div class="flex items-center justify-between">
    <span class="text-text-base text-sm">{m.mic_gain_control_label()}</span>
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
    class="accent-primary h-3 w-full md:h-auto"
    data-testid="settings-input-makeup"
  />

  <!-- Sende-Pegel-Meter: post-Gate, post-Gain. Was andere tatsächlich hören.
       Kein Label, damit der Balken exakt so breit ist wie der Eingangspegel oben. -->
  <div class="mt-1 flex items-center gap-2">
    <div class="bg-bg-input relative h-2 flex-1 overflow-hidden rounded-full">
      <!-- RMS-Füllung: glatter Durchschnittspegel. -->
      <div
        class="absolute inset-y-0 left-0 transition-[width] duration-75"
        style:width="{sendLevelPct}%"
        class:bg-emerald-500={!sendClip}
        class:bg-red-500={sendClip}
      ></div>
      <!-- Peak-Hold-Line: zeigt die lauteste Spitze der letzten ~800 ms. Das ist
           was das Clip-Lämpchen tatsächlich auslöst (Sprache: Peak ≈ RMS + 12–18 dB). -->
      <div
        class="pointer-events-none absolute inset-y-0 w-px transition-[left] duration-75"
        style:left="{sendPeakPct}%"
        class:bg-white={!sendClip}
        class:bg-red-200={sendClip}
      ></div>
    </div>
    <span
      class="size-3 shrink-0 rounded-full transition-colors"
      class:bg-red-500={sendClip}
      class:bg-bg-input={!sendClip}
      class:shadow-[0_0_6px_rgb(239_68_68)]={sendClip}
      aria-label={sendClip ? m.mic_gain_control_clipping() : m.mic_gain_control_no_clipping()}
      title={sendClip ? m.mic_gain_control_clipping_title() : ''}
    ></span>
  </div>
</div>
