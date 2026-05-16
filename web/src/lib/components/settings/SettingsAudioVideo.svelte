<script lang="ts">
  import { settings, VOICE_BITRATE_MIN, VOICE_BITRATE_MAX, VOICE_BITRATE_STEREO_MIN } from '$lib/stores/settings.svelte';
  import InfoIcon from '@lucide/svelte/icons/info';
  import type { NoiseSuppressionMode } from '$lib/stores/settings.svelte';
  import { voice } from '$lib/voice/livekit.svelte';
  import { deviceDisplayName } from '$lib/voice/devices';

  // DeepFilterNet3 fetches its WASM + model from a CDN at runtime; works out of
  // the box, no Cross-Origin-Isolation needed. Kept enabled.
  const dfnEnabled = true;

  const nsOptions: { value: NoiseSuppressionMode; label: string; hint: string }[] = [
    { value: 'off', label: 'Aus', hint: 'Keine Rauschunterdrückung — geringste CPU-Last.' },
    { value: 'browser', label: 'Browser-Standard', hint: 'Eingebaute Unterdrückung des Browsers — leicht, solide.' },
    { value: 'rnnoise', label: 'RNNoise', hint: 'Neuronales Netz, gute Qualität bei geringer CPU-Last.' },
    {
      value: 'deepfilternet',
      label: 'DeepFilterNet3',
      hint: 'Beste Qualität, mehr CPU. Modell wird beim ersten Mal aus dem Netz geladen.'
    }
  ];

  let listeningForPttKey = $state(false);

  function onNoiseChange(v: NoiseSuppressionMode) {
    settings.setNoiseSuppression(v);
    if (voice.connected) void voice.applyNoiseFilter();
  }

  // Live-display the slider value during drag (oninput), but only persist the
  // final value on release (onchange) so we don't hammer localStorage per pixel.
  let bitrateDisplay = $state(settings.audio.voiceBitrateKbps);
  $effect(() => {
    bitrateDisplay = settings.audio.voiceBitrateKbps;
  });
  function onBitrateInput(e: Event) {
    const val = parseInt((e.currentTarget as HTMLInputElement).value, 10);
    if (!isNaN(val)) bitrateDisplay = val;
  }
  function onBitrateChange(e: Event) {
    const val = parseInt((e.currentTarget as HTMLInputElement).value, 10);
    if (!isNaN(val)) settings.setVoiceBitrateKbps(val);
  }

  function startPttCapture() {
    listeningForPttKey = true;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      settings.setPttKey(e.key);
      listeningForPttKey = false;
      window.removeEventListener('keydown', onKey, true);
    };
    window.addEventListener('keydown', onKey, true);
  }

  let micLevelPct = $derived(Math.min(100, Math.round(voice.localMicLevel * 140)));
  let processorActive = $derived(settings.audio.noiseSuppression !== 'off' && settings.audio.noiseSuppression !== 'browser');
  let bitrateTooLowForStereo = $derived(settings.audio.voiceBitrateKbps < VOICE_BITRATE_STEREO_MIN);
  let stereoForced = $derived(processorActive || bitrateTooLowForStereo);
  let bitrateLabel = $derived(
    bitrateDisplay < 24
      ? 'sehr niedrig — Roboter-Sprache'
      : bitrateDisplay < 32
        ? 'sparsam'
        : bitrateDisplay <= 64
          ? 'Standard / Discord-Niveau'
          : bitrateDisplay <= 128
            ? 'hoch'
            : 'sehr hoch (Musik)'
  );
</script>

<div class="flex flex-col gap-6" data-testid="settings-audio-video-panel">
  <!-- Eingabegerät + Pegelanzeige -->
  <div class="flex flex-col gap-2">
    <span class="text-text-bright text-sm font-medium">Eingabegerät (Mikrofon)</span>
    <select
      class="bg-bg-input text-text-base h-9 rounded-md px-2 text-sm outline-none"
      value={voice.selectedInputDeviceId}
      onchange={(e) => void voice.setInputDevice((e.currentTarget as HTMLSelectElement).value)}
      data-testid="settings-input-device"
      disabled={voice.inputDevices.length === 0}
    >
      {#if voice.inputDevices.length === 0}
        <option value="">Tritt einem Sprach-Kanal bei, um Geräte zu sehen</option>
      {/if}
      {#each voice.inputDevices as d (d.deviceId)}
        <option value={d.deviceId}>{deviceDisplayName(d, 'Mikrofon')}</option>
      {/each}
    </select>
    <div class="bg-bg-input h-2 w-full overflow-hidden rounded-full" data-testid="settings-mic-level">
      <div
        class="bg-primary h-full rounded-full transition-[width] duration-75"
        style:width="{micLevelPct}%"
      ></div>
    </div>
  </div>

  <!-- Ausgabegerät -->
  <div class="flex flex-col gap-2">
    <span class="text-text-bright text-sm font-medium">Ausgabegerät</span>
    <select
      class="bg-bg-input text-text-base h-9 rounded-md px-2 text-sm outline-none"
      value={voice.selectedOutputDeviceId}
      onchange={(e) => void voice.setOutputDevice((e.currentTarget as HTMLSelectElement).value)}
      data-testid="settings-output-device"
      disabled={voice.outputDevices.length === 0}
    >
      {#if voice.outputDevices.length === 0}
        <option value="">Tritt einem Sprach-Kanal bei, um Geräte zu sehen</option>
      {/if}
      {#each voice.outputDevices as d (d.deviceId)}
        <option value={d.deviceId}>{deviceDisplayName(d, 'Ausgabegerät')}</option>
      {/each}
    </select>
  </div>

  <!-- Rauschunterdrückung -->
  <div class="flex flex-col gap-2">
    <span class="text-text-bright text-sm font-medium">Rauschunterdrückung</span>
    <div class="flex flex-col gap-1.5" data-testid="settings-noise-suppression">
      {#each nsOptions as o (o.value)}
        {@const off = o.value === 'deepfilternet' && !dfnEnabled}
        <label
          class="flex items-start gap-2.5 rounded-xl px-2 py-1.5 transition-colors {off
            ? 'cursor-not-allowed opacity-50'
            : 'cursor-pointer hover:bg-bg-hover'}"
        >
          <input
            type="radio"
            name="ns-mode"
            value={o.value}
            disabled={off}
            checked={settings.audio.noiseSuppression === o.value}
            onchange={() => onNoiseChange(o.value)}
            class="accent-primary mt-0.5"
          />
          <div>
            <span class="text-text-bright text-sm">{o.label}{off ? ' (braucht COI — siehe team-lead)' : ''}</span>
            <p class="text-text-muted text-xs">{o.hint}</p>
          </div>
        </label>
      {/each}
    </div>
  </div>

  <!-- Echo / Auto-Gain -->
  <div class="flex flex-col gap-2.5">
    <label class="flex cursor-pointer items-center justify-between gap-3">
      <span class="text-text-base text-sm">Echo-Unterdrückung</span>
      <input
        type="checkbox"
        checked={settings.audio.echoCancellation}
        onchange={(e) => settings.setEchoCancellation((e.currentTarget as HTMLInputElement).checked)}
        class="accent-primary size-4"
        data-testid="settings-echo-cancellation"
      />
    </label>
    <label class="flex cursor-pointer items-center justify-between gap-3" class:opacity-50={processorActive}>
      <div>
        <span class="text-text-base text-sm">Automatische Pegelangleichung</span>
        {#if settings.audio.noiseSuppression === 'deepfilternet'}
          <p class="text-text-muted text-xs">Von DeepFilterNet3 übernommen — deaktiviert</p>
        {:else if settings.audio.noiseSuppression === 'rnnoise'}
          <p class="text-text-muted text-xs">Von RNNoise übernommen — deaktiviert</p>
        {/if}
      </div>
      <input
        type="checkbox"
        checked={processorActive ? false : settings.audio.autoGainControl}
        onchange={(e) => settings.setAutoGainControl((e.currentTarget as HTMLInputElement).checked)}
        class="accent-primary size-4"
        disabled={processorActive}
        data-testid="settings-auto-gain"
      />
    </label>
  </div>

  <!-- Bitrate + Stereo -->
  <div class="flex flex-col gap-2">
    <div class="flex items-center justify-between">
      <span class="text-text-bright text-sm font-medium">Sprachqualität</span>
      <span class="text-text-muted text-sm">{bitrateDisplay} kbit/s · {bitrateLabel}</span>
    </div>
    <input
      type="range"
      min={VOICE_BITRATE_MIN}
      max={VOICE_BITRATE_MAX}
      step="8"
      value={settings.audio.voiceBitrateKbps}
      oninput={onBitrateInput}
      onchange={onBitrateChange}
      class="accent-primary w-full"
      data-testid="settings-voice-bitrate"
    />
    <label class="mt-1 flex cursor-pointer items-center justify-between gap-3" class:opacity-50={stereoForced}>
      <div>
        <span class="text-text-base text-sm">Stereo <span class="text-text-muted text-xs">{stereoForced ? '' : '(v.a. für Musik sinnvoll)'}</span></span>
        {#if processorActive}
          <p class="text-text-muted text-xs">Noise-Filter ist mono — Stereo hätte keinen Effekt</p>
        {:else if bitrateTooLowForStereo}
          <p class="text-text-muted text-xs">Bitrate zu niedrig — min. {VOICE_BITRATE_STEREO_MIN} kbit/s für Stereo</p>
        {/if}
      </div>
      <input
        type="checkbox"
        checked={stereoForced ? false : settings.audio.stereo}
        onchange={(e) => settings.setStereo((e.currentTarget as HTMLInputElement).checked)}
        class="accent-primary size-4"
        disabled={stereoForced}
        data-testid="settings-stereo"
      />
    </label>
  </div>

  <!-- Push-to-Talk -->
  <div class="flex flex-col gap-2">
    <span class="text-text-bright text-sm font-medium">Push-to-Talk</span>
    <label class="flex cursor-pointer items-center justify-between gap-3">
      <span class="text-text-base text-sm">Push-to-Talk aktivieren</span>
      <input
        type="checkbox"
        checked={settings.voice.pttMode}
        onchange={(e) => void voice.setPttMode((e.currentTarget as HTMLInputElement).checked)}
        class="accent-primary size-4"
        data-testid="settings-ptt-toggle"
      />
    </label>
    <div class="flex items-center justify-between gap-3">
      <span class="text-text-base text-sm">Taste</span>
      <button
        type="button"
        onclick={startPttCapture}
        class="bg-bg-input text-text-bright hover:bg-bg-hover rounded-full border border-border px-3 py-1.5 text-sm uppercase transition-colors"
        data-testid="settings-ptt-key"
      >
        {listeningForPttKey ? 'Taste drücken…' : settings.voice.pttKey}
      </button>
    </div>
  </div>

  <div class="border-primary/30 bg-primary/5 mt-2 flex items-start gap-2 rounded-lg border-l-2 px-3 py-2">
    <InfoIcon class="text-primary/80 mt-0.5 size-3.5 shrink-0" />
    <p class="text-text-muted text-xs leading-relaxed">
      <span class="text-text-base">Bitrate, Stereo und Echo/Auto-Gain</span> greifen erst, wenn du das nächste Mal
      einem Sprach-Kanal beitrittst. <span class="text-text-base">Rauschunterdrückung</span> und
      <span class="text-text-base">Ein-/Ausgabegerät</span> wirken sofort.
    </p>
  </div>
</div>
