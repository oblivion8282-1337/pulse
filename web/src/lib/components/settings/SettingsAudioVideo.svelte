<script lang="ts">
  import {
    settings,
    VOICE_BITRATE_MIN,
    VOICE_BITRATE_MAX,
    VOICE_BITRATE_STEREO_MIN,
    NOISE_GATE_DB_MIN,
    NOISE_GATE_DB_MAX
  } from '$lib/stores/settings.svelte';
  import InfoIcon from '@lucide/svelte/icons/info';
  import { voice } from '$lib/voice/livekit.svelte';
  import { deviceDisplayName } from '$lib/voice/devices';
  import MicGainControl from './MicGainControl.svelte';

  let listeningForPttKey = $state(false);

  function onNoiseToggle(e: Event) {
    const on = (e.currentTarget as HTMLInputElement).checked;
    settings.setNoiseSuppression(on ? 'rnnoise_gated' : 'off');
    if (voice.connected) void voice.applyNoiseFilter();
  }

  function onLimiterToggle(e: Event) {
    const on = (e.currentTarget as HTMLInputElement).checked;
    settings.setLimiterEnabled(on);
    voice.setLimiterEnabled(on);
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

  // Gate threshold: live-rebuild the gate node on drag (oninput, brief click —
  // intended; user is fine-tuning by ear), persist on release.
  let gateDbDisplay = $state(settings.audio.noiseGateThresholdDb);
  $effect(() => {
    gateDbDisplay = settings.audio.noiseGateThresholdDb;
  });
  function onGateInput(e: Event) {
    const val = parseInt((e.currentTarget as HTMLInputElement).value, 10);
    if (isNaN(val)) return;
    gateDbDisplay = val;
    voice.setNoiseGateThresholdDb(val);
  }
  function onGateChange(e: Event) {
    const val = parseInt((e.currentTarget as HTMLInputElement).value, 10);
    if (!isNaN(val)) settings.setNoiseGateThresholdDb(val);
  }
  let gateDbLabel = $derived(
    gateDbDisplay <= -55
      ? 'sehr empfindlich — fast alles kommt durch'
      : gateDbDisplay <= -40
        ? 'leise Stimme reicht'
        : gateDbDisplay <= -30
          ? 'normale Sprachlautstärke'
          : 'nur lautes — Flüstern wird stumm'
  );

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

  let micLevelPct = $derived(Math.round(voice.localMicLevel * 100));
  let micPeakPct = $derived(Math.round(voice.localMicPeak * 100));
  let processorActive = $derived(settings.audio.noiseSuppression !== 'off');
  // Map the LIVE gate threshold (dBFS) onto the mic meter's 0..100% axis using
  // the same dBFS-to-display scale LocalMicAnalyser uses (-50..-5 dB → 0..1).
  // Imperfect: the gate measures post-RNNoise while the meter shows raw mic —
  // but for speech the levels are close enough that the marker is a useful
  // "your voice peaks must clear this line" anchor. Hidden when NS is off.
  let gateMarkerPct = $derived(
    Math.round(Math.max(0, Math.min(1, (gateDbDisplay + 50) / 45)) * 100)
  );
  let gateOpen = $derived(!processorActive || micLevelPct >= gateMarkerPct);
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
      class="bg-bg-input text-text-base h-11 rounded-md px-2 text-sm outline-none md:h-9"
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
    <div class="flex items-center gap-2">
      <div class="bg-bg-input relative h-2 flex-1 overflow-hidden rounded-full" data-testid="settings-mic-level">
        <!-- RMS-Füllung: das was die Gate-Schwelle vergleicht (short-window RMS). -->
        <div
          class="h-full rounded-full transition-[width] duration-75"
          class:bg-primary={gateOpen}
          class:bg-text-muted={!gateOpen}
          class:opacity-40={!gateOpen}
          style:width="{micLevelPct}%"
        ></div>
        <!-- Peak-Hold-Line: lauteste Spitze der letzten ~800 ms; raw-Mic-Clip wenn am rechten Rand. -->
        <div
          class="bg-white pointer-events-none absolute inset-y-0 w-px transition-[left] duration-75"
          style:left="{micPeakPct}%"
          aria-hidden="true"
        ></div>
        {#if processorActive}
          <!-- Gate-Schwelle (live aus settings.audio.noiseGateThresholdDb) -->
          <div
            class="border-text-bright/80 pointer-events-none absolute inset-y-0 border-l-2"
            style:left="{gateMarkerPct}%"
            aria-hidden="true"
            title={`Gate-Schwelle: ${gateDbDisplay} dB`}
          ></div>
        {/if}
      </div>
      <!-- Clip-Lämpchen für rohen Mic-Pegel: leuchtet wenn Peak > -1 dBFS. Bedeutet
           OS-Mic-Gain ist zu hoch — bekommt der Slider nicht repariert. -->
      <span
        class="size-3 shrink-0 rounded-full transition-colors"
        class:bg-red-500={voice.localMicClip}
        class:bg-bg-input={!voice.localMicClip}
        class:shadow-[0_0_6px_rgb(239_68_68)]={voice.localMicClip}
        aria-label={voice.localMicClip ? 'Mic-Eingang clippt — OS-Pegel reduzieren' : 'Mic-Eingang ok'}
        title={voice.localMicClip ? 'Mic-Eingang clippt — OS-Pegel reduzieren' : ''}
      ></span>
    </div>
  </div>

  <!-- Ausgabegerät -->
  <div class="flex flex-col gap-2">
    <span class="text-text-bright text-sm font-medium">Ausgabegerät</span>
    <select
      class="bg-bg-input text-text-base h-11 rounded-md px-2 text-sm outline-none md:h-9"
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

  <!-- Lautstärke-Limiter (Wiedergabe) -->
  <div class="flex flex-col gap-2">
    <label class="flex cursor-pointer items-center justify-between gap-3" data-testid="settings-limiter">
      <div>
        <span class="text-text-bright text-sm font-medium">Lautstärke-Limiter</span>
        <p class="text-text-muted text-xs">Fängt Spitzen ab, wenn jemand plötzlich sehr laut wird — schützt deine Ohren, ohne normales Sprechen zu verändern.</p>
      </div>
      <input
        type="checkbox"
        checked={settings.audio.limiterEnabled}
        onchange={onLimiterToggle}
        class="accent-primary size-5 md:size-4"
      />
    </label>
  </div>

  <!-- Rauschunterdrückung -->
  <div class="flex flex-col gap-2">
    <label class="flex cursor-pointer items-center justify-between gap-3" data-testid="settings-noise-suppression">
      <div>
        <span class="text-text-bright text-sm font-medium">Rauschunterdrückung</span>
        <p class="text-text-muted text-xs">Schneidet Hintergrundgeräusche weg und macht Pausen zwischen Wörtern sauber.</p>
      </div>
      <input
        type="checkbox"
        checked={settings.audio.noiseSuppression !== 'off'}
        onchange={onNoiseToggle}
        class="accent-primary size-5 md:size-4"
      />
    </label>
    {#if settings.audio.noiseSuppression !== 'off'}
      <div class="mt-1 flex flex-col gap-1.5" data-testid="settings-noise-gate">
        <div class="flex items-center justify-between">
          <span class="text-text-base text-sm">Gate-Schwelle</span>
          <span class="text-text-muted text-sm">{gateDbDisplay} dB · {gateDbLabel}</span>
        </div>
        <input
          type="range"
          min={NOISE_GATE_DB_MIN}
          max={NOISE_GATE_DB_MAX}
          step="1"
          value={settings.audio.noiseGateThresholdDb}
          oninput={onGateInput}
          onchange={onGateChange}
          class="accent-primary h-3 w-full md:h-auto"
        />
        <p class="text-text-muted text-xs">Schwelle so wählen, dass sie unter deiner Stimme, aber über dem Hintergrund liegt.</p>
      </div>
    {/if}
  </div>

  <!-- Echo / Auto-Gain -->
  <div class="flex flex-col gap-2.5">
    <label class="flex cursor-pointer items-center justify-between gap-3">
      <span class="text-text-base text-sm">Echo-Unterdrückung</span>
      <input
        type="checkbox"
        checked={settings.audio.echoCancellation}
        onchange={(e) => settings.setEchoCancellation((e.currentTarget as HTMLInputElement).checked)}
        class="accent-primary size-5 md:size-4"
        data-testid="settings-echo-cancellation"
      />
    </label>
    <label class="flex cursor-pointer items-center justify-between gap-3" class:opacity-50={processorActive}>
      <div>
        <span class="text-text-base text-sm">Automatische Pegelangleichung</span>
        {#if settings.audio.noiseSuppression !== 'off'}
          <p class="text-text-muted text-xs">Wird von der Rauschunterdrückung übernommen</p>
        {/if}
      </div>
      <input
        type="checkbox"
        checked={processorActive ? false : settings.audio.autoGainControl}
        onchange={(e) => settings.setAutoGainControl((e.currentTarget as HTMLInputElement).checked)}
        class="accent-primary size-5 md:size-4"
        disabled={processorActive}
        data-testid="settings-auto-gain"
      />
    </label>
  </div>

  <MicGainControl />

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
      class="accent-primary h-3 w-full md:h-auto"
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
        class="accent-primary size-5 md:size-4"
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
        class="accent-primary size-5 md:size-4"
        data-testid="settings-ptt-toggle"
      />
    </label>
    <div class="flex items-center justify-between gap-3">
      <span class="text-text-base text-sm">Taste</span>
      <button
        type="button"
        onclick={startPttCapture}
        class="bg-bg-input text-text-bright hover:bg-bg-hover rounded-full border border-border px-3 py-2 text-sm uppercase transition-colors md:py-1.5"
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
      einem Sprach-Kanal beitrittst. <span class="text-text-base">Rauschunterdrückung</span>,
      <span class="text-text-base">Limiter</span> und <span class="text-text-base">Ein-/Ausgabegerät</span> wirken sofort.
    </p>
  </div>
</div>
