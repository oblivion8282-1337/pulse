<script lang="ts">
  import { settings, VOICE_BITRATE_MIN, VOICE_BITRATE_MAX } from '$lib/stores/settings.svelte';
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

  function onBitrateInput(e: Event) {
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
  let bitrateLabel = $derived(
    settings.audio.voiceBitrateKbps <= 32
      ? 'sparsam'
      : settings.audio.voiceBitrateKbps <= 64
        ? 'Standard / Discord-Niveau'
        : settings.audio.voiceBitrateKbps <= 128
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
        class="bg-primary h-full rounded-full transition-[width] duration-50"
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
    <label class="flex cursor-pointer items-center justify-between gap-3" class:opacity-50={settings.audio.noiseSuppression === 'deepfilternet'}>
      <div>
        <span class="text-text-base text-sm">Automatische Pegelangleichung</span>
        {#if settings.audio.noiseSuppression === 'deepfilternet'}
          <p class="text-text-muted text-xs">Von DeepFilterNet3 übernommen — deaktiviert</p>
        {/if}
      </div>
      <input
        type="checkbox"
        checked={settings.audio.noiseSuppression === 'deepfilternet' ? false : settings.audio.autoGainControl}
        onchange={(e) => settings.setAutoGainControl((e.currentTarget as HTMLInputElement).checked)}
        class="accent-primary size-4"
        disabled={settings.audio.noiseSuppression === 'deepfilternet'}
        data-testid="settings-auto-gain"
      />
    </label>
  </div>

  <!-- Bitrate + Stereo -->
  <div class="flex flex-col gap-2">
    <div class="flex items-center justify-between">
      <span class="text-text-bright text-sm font-medium">Sprachqualität</span>
      <span class="text-text-muted text-sm">{settings.audio.voiceBitrateKbps} kbit/s · {bitrateLabel}</span>
    </div>
    <input
      type="range"
      min={VOICE_BITRATE_MIN}
      max={VOICE_BITRATE_MAX}
      step="8"
      value={settings.audio.voiceBitrateKbps}
      oninput={onBitrateInput}
      class="accent-primary w-full"
      data-testid="settings-voice-bitrate"
    />
    <label class="mt-1 flex cursor-pointer items-center justify-between gap-3">
      <span class="text-text-base text-sm">Stereo <span class="text-text-muted text-xs">(nur ab ~64 kbit/s sinnvoll, v.a. für Musik)</span></span>
      <input
        type="checkbox"
        checked={settings.audio.stereo}
        onchange={(e) => settings.setStereo((e.currentTarget as HTMLInputElement).checked)}
        class="accent-primary size-4"
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

  <p class="text-text-muted text-xs">
    Einige Änderungen (Bitrate, Stereo, Echo/Auto-Gain, Rauschunterdrückung auf „Browser-Standard") greifen erst,
    wenn du das nächste Mal einem Sprach-Kanal beitrittst.
  </p>
</div>
