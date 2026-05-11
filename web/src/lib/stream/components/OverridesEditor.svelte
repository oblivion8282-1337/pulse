<!--
  OverridesEditor — Codec/Bitrate/FPS/Auflösung als manuelle Werte.

  Nur sichtbar wenn `streamSettings.use_overrides` true ist (z.B. weil
  "Custom" gewählt wurde oder der Toggle in StreamPanel auf manuell steht).
  Validierung minimal: Bitrate 1000-50000, FPS 1-360, Resolution aus festem
  Set, Codec aus dem 7er-Set in `settings.svelte.ts`.

  Bei jedem Edit wird das `Custom`-Profil aktiviert — Pattern aus der alten
  Qt-UI (`_mark_as_custom_if_user_edit`). Dort: Slider/Spinbox bewegen
  schaltet automatisch auf Custom. Hier analog: jede Override-Mutation
  bedeutet, der User will benutzerdefinierte Werte, also Profil = Custom.
-->
<script lang="ts">
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import {
    streamSettings,
    CODEC_VALUES,
    RESOLUTION_VALUES,
    isCustomProfile,
  } from '../settings.svelte';

  function markCustom() {
    // Identisch zu _mark_as_custom_if_user_edit in der alten Qt-UI:
    // Sobald der User einen Override editiert, schalt auf "Custom".
    if (
      !isCustomProfile() &&
      streamSettings.available_profiles.some((p) => p.name === 'Custom')
    ) {
      streamSettings.profile_name = 'Custom';
    }
  }

  function onCodec(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
    streamSettings.overrides = { ...streamSettings.overrides, codec: v || undefined };
    markCustom();
  }

  function onBitrate(e: Event) {
    const raw = (e.currentTarget as HTMLInputElement).value;
    const n = parseInt(raw, 10);
    streamSettings.overrides = {
      ...streamSettings.overrides,
      bitrate_kbps: isNaN(n) ? undefined : Math.max(0, n),
    };
    markCustom();
  }

  function onFps(e: Event) {
    const raw = (e.currentTarget as HTMLInputElement).value;
    const n = parseInt(raw, 10);
    streamSettings.overrides = {
      ...streamSettings.overrides,
      fps: isNaN(n) ? undefined : Math.min(360, Math.max(0, n)),
    };
    markCustom();
  }

  function onResolution(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
    streamSettings.overrides = { ...streamSettings.overrides, resolution: v || undefined };
    markCustom();
  }

  let codecValue = $derived(streamSettings.overrides.codec ?? '');
  let bitrateValue = $derived(streamSettings.overrides.bitrate_kbps ?? '');
  let fpsValue = $derived(streamSettings.overrides.fps ?? '');
  let resValue = $derived(streamSettings.overrides.resolution ?? '');
</script>

<div class="grid gap-3 sm:grid-cols-2" data-testid="stream-overrides-editor">
  <div class="flex flex-col gap-1.5">
    <Label for="ov-codec">Codec</Label>
    <select
      id="ov-codec"
      class="bg-bg-input text-text-base h-9 rounded-md px-2 text-sm outline-none"
      value={codecValue}
      onchange={onCodec}
      data-testid="stream-overrides-codec"
    >
      <option value="">Profil-Default</option>
      {#each CODEC_VALUES as c (c.value)}
        <option value={c.value}>{c.label}</option>
      {/each}
    </select>
  </div>

  <div class="flex flex-col gap-1.5">
    <Label for="ov-resolution">Auflösung</Label>
    <select
      id="ov-resolution"
      class="bg-bg-input text-text-base h-9 rounded-md px-2 text-sm outline-none"
      value={resValue}
      onchange={onResolution}
      data-testid="stream-overrides-resolution"
    >
      <option value="">Profil-Default</option>
      {#each RESOLUTION_VALUES as r (r)}
        <option value={r}>{r}</option>
      {/each}
    </select>
  </div>

  <div class="flex flex-col gap-1.5">
    <Label for="ov-bitrate">Bitrate (kbps)</Label>
    <Input
      id="ov-bitrate"
      type="number"
      min="1000"
      max="50000"
      step="500"
      placeholder="z.B. 8000"
      value={bitrateValue}
      oninput={onBitrate}
      data-testid="stream-overrides-bitrate"
    />
  </div>

  <div class="flex flex-col gap-1.5">
    <Label for="ov-fps">FPS</Label>
    <Input
      id="ov-fps"
      type="number"
      min="1"
      max="360"
      step="1"
      placeholder="z.B. 60"
      value={fpsValue}
      oninput={onFps}
      data-testid="stream-overrides-fps"
    />
  </div>
</div>
