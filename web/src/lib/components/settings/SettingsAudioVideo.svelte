<script lang="ts">
  import {
    settings,
    VOICE_BITRATE_MIN,
    VOICE_BITRATE_MAX,
    VOICE_BITRATE_STEREO_MIN,
    NOISE_GATE_DB_MIN,
    NOISE_GATE_DB_MAX
  } from '$lib/stores/settings.svelte';
  import { voice } from '$lib/voice/livekit.svelte';
  import { micTest } from '$lib/voice/micTest.svelte';
  import { isMobile } from '$lib/platform/runtime';
  import { deviceDisplayName } from '$lib/voice/devices';
  import MicGainControl from './MicGainControl.svelte';
  import OutputVolumeControl from './OutputVolumeControl.svelte';
  import { onDestroy, untrack } from 'svelte';
  import { m } from '$lib/paraglide/messages.js';

  // Standalone mic test: runs while this tab is open and we're NOT in a voice
  // channel, so the level meter moves and "hear yourself" works without joining.
  // In a channel, voice.localMic* is the live source and the test stays off.
  async function startTest() {
    await micTest.start(settings.audio.inputDeviceId, settings.audio.outputDeviceId);
    await voice.refreshDevices(); // populate the pickers now that we have a grant
  }
  $effect(() => {
    if (voice.connected) {
      micTest.stop();
      return;
    }
    untrack(() => void startTest());
    return () => micTest.stop();
  });

  async function onInputChange(deviceId: string) {
    await voice.setInputDevice(deviceId);
    if (!voice.connected) await micTest.start(deviceId, settings.audio.outputDeviceId);
  }
  async function onOutputChange(deviceId: string) {
    await voice.setOutputDevice(deviceId);
    if (!voice.connected) await micTest.setOutput(deviceId);
  }

  function onNoiseSuppressionChange(on: boolean) {
    settings.setNoiseSuppression(on ? 'rnnoise_gated' : 'off');
    if (voice.connected) void voice.applyNoiseFilter();
    // Toggling NS switches the test processor between rnnoise+gate and gain-only
    // — rebuild it so the loopback + send meter reflect the new chain.
    else void micTest.start(settings.audio.inputDeviceId, settings.audio.outputDeviceId);
  }

  let listeningForPttKey = $state(false);
  let pttKeyListener: ((e: KeyboardEvent) => void) | null = null;

  function inputInt(e: Event): number | null {
    const val = parseInt((e.currentTarget as HTMLInputElement).value, 10);
    return isNaN(val) ? null : val;
  }

  // Live-display the slider value during drag (oninput), but only persist the
  // final value on release (onchange) so we don't hammer localStorage per pixel.
  let bitrateDisplay = $state(settings.audio.voiceBitrateKbps);
  $effect(() => {
    bitrateDisplay = settings.audio.voiceBitrateKbps;
  });
  function onBitrateInput(e: Event) {
    const val = inputInt(e);
    if (val !== null) bitrateDisplay = val;
  }
  function onBitrateChange(e: Event) {
    const val = inputInt(e);
    if (val !== null) settings.setVoiceBitrateKbps(val);
  }

  // Gate threshold: live-rebuild the gate node on drag (oninput, brief click —
  // intended; user is fine-tuning by ear), persist on release.
  let gateDbDisplay = $state(settings.audio.noiseGateThresholdDb);
  $effect(() => {
    gateDbDisplay = settings.audio.noiseGateThresholdDb;
  });
  function onGateInput(e: Event) {
    const val = inputInt(e);
    if (val === null) return;
    gateDbDisplay = val;
    voice.setNoiseGateThresholdDb(val);
    micTest.setGateThreshold(val);
  }
  function onGateChange(e: Event) {
    const val = inputInt(e);
    if (val !== null) settings.setNoiseGateThresholdDb(val);
  }

  function startPttCapture() {
    // Doppel-Klick ohne zwischenzeitlichen Tastendruck: den alten Listener
    // ZUERST entfernen, sonst überschreibt Zeile darunter pttKeyListener und
    // der alte Closure bleibt im Capture-Phase registriert — schluckt dann
    // jeden weiteren keydown (preventDefault/stopPropagation) bis Reload.
    if (pttKeyListener) {
      window.removeEventListener('keydown', pttKeyListener, true);
      pttKeyListener = null;
    }
    listeningForPttKey = true;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      settings.setPttKey(e.key);
      listeningForPttKey = false;
      // handler direkt entfernen (nicht über die mutable Variable, die schon
      // auf einen neueren Closure zeigen könnte).
      window.removeEventListener('keydown', handler, true);
      pttKeyListener = null;
    };
    pttKeyListener = handler;
    window.addEventListener('keydown', handler, true);
  }

  onDestroy(() => {
    if (pttKeyListener) {
      window.removeEventListener('keydown', pttKeyListener, true);
      pttKeyListener = null;
    }
  });

  let spatialDisabled = $derived(isMobile());

  // Meter reads the live channel when connected, else the standalone mic test.
  let micClip = $derived(voice.connected ? voice.localMicClip : micTest.clip);
  let micLevelPct = $derived(Math.round((voice.connected ? voice.localMicLevel : micTest.level) * 100));
  let micPeakPct = $derived(Math.round((voice.connected ? voice.localMicPeak : micTest.peak) * 100));
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
  function bitrateLabelFor(kbps: number): string {
    if (kbps < 24) return m.settings_audio_video_bitrate_label_very_low();
    if (kbps < 32) return m.settings_audio_video_bitrate_label_sparse();
    if (kbps <= 64) return m.settings_audio_video_bitrate_label_standard();
    if (kbps <= 128) return m.settings_audio_video_bitrate_label_high();
    return m.settings_audio_video_bitrate_label_very_high();
  }
  let bitrateLabel = $derived(bitrateLabelFor(bitrateDisplay));
</script>

<div class="flex flex-col gap-6" data-testid="settings-audio-video-panel">
  <!-- ===== Feld: Eingabe ===== -->
  <div class="border-border flex flex-col gap-4 rounded-lg border p-4">
    <!-- Eingabegerät + Pegelanzeige -->
    <div class="flex flex-col gap-2">
      <span class="text-text-bright text-sm font-medium">{m.settings_audio_video_input_device_label()}</span>
      <select
        class="bg-bg-input text-text-base h-11 rounded-md px-2 text-sm outline-none md:h-9"
        value={voice.selectedInputDeviceId}
        onchange={(e) => void onInputChange((e.currentTarget as HTMLSelectElement).value)}
        data-testid="settings-input-device"
        disabled={voice.inputDevices.length === 0}
      >
        {#if voice.inputDevices.length === 0}
          <option value="">{m.settings_audio_video_join_voice_to_see_devices()}</option>
        {/if}
        {#each voice.inputDevices as d (d.deviceId)}
          <option value={d.deviceId}>{deviceDisplayName(d, m.settings_audio_video_microphone())}</option>
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
              class="border-red-500 pointer-events-none absolute inset-y-0 border-l-2"
              style:left="{gateMarkerPct}%"
              aria-hidden="true"
              title={m.settings_audio_video_gate_threshold_title({ db: gateDbDisplay })}
            ></div>
          {/if}
        </div>
        <!-- Clip-Lämpchen für rohen Mic-Pegel: leuchtet wenn Peak > -1 dBFS. Bedeutet
             OS-Mic-Gain ist zu hoch — bekommt der Slider nicht repariert. -->
        <span
          class="size-3 shrink-0 rounded-full transition-colors"
          class:bg-red-500={micClip}
          class:bg-bg-input={!micClip}
          class:shadow-[0_0_6px_rgb(239_68_68)]={micClip}
          aria-label={micClip ? m.settings_audio_video_mic_clipping() : m.settings_audio_video_mic_ok()}
          title={micClip ? m.settings_audio_video_mic_clipping() : ''}
        ></span>
      </div>
      <!-- Gate-Schwelle direkt unter dem Pegel — ihr Marker-Strich sitzt im Meter
           darüber, und sie entscheidet ab welchem Pegel der Ton durchgeht. -->
      {#if processorActive}
        <div class="mt-1 flex flex-col gap-1.5" data-testid="settings-noise-gate">
          <div class="flex items-center justify-between">
            <span class="text-text-base text-sm">{m.settings_audio_video_gate_threshold_label()}</span>
            <span class="text-text-muted text-sm">{gateDbDisplay} dB</span>
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
        </div>
      {/if}
    </div>

    <!-- Eingabe-Verstärkung: Sendepegel im direkten Vergleich zum Eingangspegel. -->
    <MicGainControl />

    <!-- Eigenen Ton hören (Loopback zum Ausgabegerät) — nur außerhalb eines
         Voice-Kanals sinnvoll; im Kanal hört man sich nicht selbst zurück. -->
    {#if !voice.connected}
      <label class="flex cursor-pointer items-center justify-between gap-3" data-testid="settings-mic-monitor">
        <span class="text-text-base text-sm">{m.settings_audio_video_monitor_label()}</span>
        <input
          type="checkbox"
          role="switch"
          checked={micTest.monitor}
          onchange={(e) => void micTest.setMonitor((e.currentTarget as HTMLInputElement).checked, settings.audio.outputDeviceId)}
          class="accent-primary size-5 md:size-4"
        />
      </label>
    {/if}

    <!-- Sprachqualität (Bitrate) -->
    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <span class="text-text-base text-sm">{m.settings_audio_video_voice_quality_label()}</span>
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
    </div>
  </div>

  <!-- ===== Feld: Ausgabe ===== -->
  <div class="border-border flex flex-col gap-4 rounded-lg border p-4">
    <!-- Ausgabegerät -->
    <div class="flex flex-col gap-2">
      <span class="text-text-bright text-sm font-medium">{m.settings_audio_video_output_device_label()}</span>
      <select
        class="bg-bg-input text-text-base h-11 rounded-md px-2 text-sm outline-none md:h-9"
        value={voice.selectedOutputDeviceId}
        onchange={(e) => void onOutputChange((e.currentTarget as HTMLSelectElement).value)}
        data-testid="settings-output-device"
        disabled={voice.outputDevices.length === 0}
      >
        {#if voice.outputDevices.length === 0}
          <option value="">{m.settings_audio_video_join_voice_to_see_devices()}</option>
        {/if}
        {#each voice.outputDevices as d (d.deviceId)}
          <option value={d.deviceId}>{deviceDisplayName(d, m.settings_audio_video_output_device_label())}</option>
        {/each}
      </select>
    </div>

    <!-- Wiedergabe-Lautstärke -->
    <OutputVolumeControl />

    <!-- Rauschunterdrückung -->
    <label class="flex cursor-pointer items-center justify-between gap-3" data-testid="settings-noise-suppression">
      <span class="text-text-base text-sm">{m.settings_audio_video_noise_suppression_label()}</span>
      <input
        type="checkbox"
        checked={settings.audio.noiseSuppression !== 'off'}
        onchange={(e) => onNoiseSuppressionChange((e.currentTarget as HTMLInputElement).checked)}
        class="accent-primary size-5 md:size-4"
      />
    </label>

    <!-- Echo-Unterdrückung -->
    <label class="flex cursor-pointer items-center justify-between gap-3">
      <span class="text-text-base text-sm">{m.settings_audio_video_echo_cancellation_label()}</span>
      <input
        type="checkbox"
        checked={settings.audio.echoCancellation}
        onchange={(e) => settings.setEchoCancellation((e.currentTarget as HTMLInputElement).checked)}
        class="accent-primary size-5 md:size-4"
        data-testid="settings-echo-cancellation"
      />
    </label>

    <!-- Empfangs-Lautstärke-Limiter -->
    <label class="flex cursor-pointer items-center justify-between gap-3" data-testid="settings-limiter">
      <span class="text-text-base text-sm">{m.settings_audio_video_limiter_label()}</span>
      <input
        type="checkbox"
        checked={settings.audio.limiterEnabled}
        onchange={(e) => { const on = (e.currentTarget as HTMLInputElement).checked; settings.setLimiterEnabled(on); voice.setLimiterEnabled(on); }}
        class="accent-primary size-5 md:size-4"
      />
    </label>

    <!-- Räumlicher Klang (Spatial Audio) -->
    <div class="flex flex-col gap-2" data-testid="settings-spatial-audio">
      <label
        class="flex items-center justify-between gap-3"
        class:opacity-50={spatialDisabled}
        class:cursor-pointer={!spatialDisabled}
      >
        <span class="text-text-base text-sm">{m.settings_audio_video_spatial_label()}</span>
        <input
          type="checkbox"
          role="switch"
          checked={settings.audio.spatialMode !== 'off'}
          disabled={spatialDisabled}
          onchange={(e) => {
            const mode = (e.currentTarget as HTMLInputElement).checked ? 'high' : 'off';
            settings.setSpatialMode(mode);
            voice.setSpatialMode(mode);
          }}
          class="accent-primary size-5 md:size-4"
          data-testid="settings-spatial-toggle"
        />
      </label>
      {#if spatialDisabled}
        <p class="text-text-muted text-xs">{m.settings_audio_video_spatial_desktop_only()}</p>
      {/if}
    </div>

    <!-- Stereo -->
    <div class="flex flex-col gap-2">
      <label class="flex cursor-pointer items-center justify-between gap-3" class:opacity-50={stereoForced}>
        <span class="text-text-base text-sm">Stereo</span>
        <input
          type="checkbox"
          checked={stereoForced ? false : settings.audio.stereo}
          onchange={(e) => settings.setStereo((e.currentTarget as HTMLInputElement).checked)}
          class="accent-primary size-5 md:size-4"
          disabled={stereoForced}
          data-testid="settings-stereo"
        />
      </label>
      {#if processorActive}
        <p class="text-text-muted text-xs">{m.settings_audio_video_stereo_needs_noise_off()}</p>
      {/if}
    </div>
  </div>

  <!-- ===== Feld: Push-to-Talk ===== -->
  <div class="border-border flex flex-col gap-4 rounded-lg border p-4">
    <label class="flex cursor-pointer items-center justify-between gap-3">
      <span class="text-text-base text-sm">{m.settings_audio_video_ptt_enable()}</span>
      <input
        type="checkbox"
        checked={settings.voice.pttMode}
        onchange={(e) => void voice.setPttMode((e.currentTarget as HTMLInputElement).checked)}
        class="accent-primary size-5 md:size-4"
        data-testid="settings-ptt-toggle"
      />
    </label>
    <div class="flex items-center justify-between gap-3">
      <span class="text-text-base text-sm">{m.settings_audio_video_ptt_key_label()}</span>
      <button
        type="button"
        onclick={startPttCapture}
        class="bg-bg-input text-text-bright hover:bg-bg-hover rounded-full border border-border px-3 py-2 text-sm uppercase transition-colors md:py-1.5"
        data-testid="settings-ptt-key"
      >
        {listeningForPttKey ? m.settings_audio_video_ptt_press_key() : settings.voice.pttKey}
      </button>
    </div>
  </div>
</div>
