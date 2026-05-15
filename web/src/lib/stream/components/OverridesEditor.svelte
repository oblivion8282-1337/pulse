<!--
  OverridesEditor — die zentralen Stream-Einstellungen: Codec, Auflösung,
  Bitrate, FPS. (Hieß historisch "Overrides", weil es früher Profile gab; die
  sind raus — diese vier Werte gehen jetzt direkt an den Encoder.)

  Validierung: Bitrate `HQ_BITRATE_MIN_KBPS`–`HQ_BITRATE_MAX_KBPS` (Cap gegen
  VPS-Bandbreiten-Saturation), FPS 1–360, Auflösung aus dem festen Set,
  Codec aus `CODEC_VALUES`.
-->
<script lang="ts">
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import {
    streamSettings,
    CODEC_VALUES,
    RESOLUTION_VALUES,
    HQ_BITRATE_MIN_KBPS,
    HQ_BITRATE_MAX_KBPS,
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
      bitrate_kbps: isNaN(n) ? undefined : Math.min(HQ_BITRATE_MAX_KBPS, Math.max(0, n)),
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

  function onShowCursor(e: Event) {
    streamSettings.show_cursor = (e.currentTarget as HTMLInputElement).checked;
    persistSettings();
  }
</script>

<div class="flex flex-col gap-3" data-testid="stream-overrides-editor">
 <div class="grid gap-3 sm:grid-cols-2">
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
      min={HQ_BITRATE_MIN_KBPS}
      max={HQ_BITRATE_MAX_KBPS}
      step="500"
      placeholder="z.B. 6000"
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

  <label class="flex cursor-pointer items-center gap-2 text-sm">
    <input
      type="checkbox"
      class="size-4 accent-primary"
      checked={streamSettings.show_cursor}
      onchange={onShowCursor}
      data-testid="stream-overrides-show-cursor"
    />
    <span class="text-text-base">Mauszeiger im Stream zeigen</span>
  </label>
</div>
