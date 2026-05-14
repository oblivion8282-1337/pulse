<!--
  OverridesEditor — die zentralen Stream-Einstellungen: Codec, Auflösung,
  Bitrate, FPS. (Hieß historisch "Overrides", weil es früher Profile gab; die
  sind raus — diese vier Werte gehen jetzt direkt an GSR.)

  Validierung minimal: Bitrate 1000–50000 kbps, FPS 1–360, Auflösung aus dem
  festen Set, Codec aus `CODEC_VALUES` (H.264 / AV1).
-->
<script lang="ts">
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import {
    streamSettings,
    CODEC_VALUES,
    RESOLUTION_VALUES,
    persistSettings,
  } from '../settings.svelte';

  function onCodec(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value || 'h264';
    streamSettings.overrides = { ...streamSettings.overrides, codec: v };
    persistSettings();
  }

  function onBitrate(e: Event) {
    const raw = (e.currentTarget as HTMLInputElement).value;
    const n = parseInt(raw, 10);
    streamSettings.overrides = {
      ...streamSettings.overrides,
      bitrate_kbps: isNaN(n) ? undefined : Math.max(0, n),
    };
    persistSettings();
  }

  function onFps(e: Event) {
    const raw = (e.currentTarget as HTMLInputElement).value;
    const n = parseInt(raw, 10);
    streamSettings.overrides = {
      ...streamSettings.overrides,
      fps: isNaN(n) ? undefined : Math.min(360, Math.max(0, n)),
    };
    persistSettings();
  }

  function onResolution(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value || 'Native';
    streamSettings.overrides = { ...streamSettings.overrides, resolution: v };
    persistSettings();
  }

  let codecValue = $derived(streamSettings.overrides.codec ?? 'h264');
  let bitrateValue = $derived(streamSettings.overrides.bitrate_kbps ?? '');
  let fpsValue = $derived(streamSettings.overrides.fps ?? '');
  let resValue = $derived(streamSettings.overrides.resolution ?? 'Native');
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
      {#each RESOLUTION_VALUES as r (r)}
        <option value={r}>{r === 'Native' ? 'Native (Bildschirm)' : r}</option>
      {/each}
    </select>
    <p class="text-text-muted text-[11px]">
      Nichts über deiner Monitorauflösung wählen — der Encoder skaliert dann nur
      hoch (mehr Bandbreite, kein Detailgewinn).
    </p>
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
