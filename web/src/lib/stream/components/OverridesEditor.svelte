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
    allowedResolutions,
    clampResolution,
    persistSettings,
  } from '../settings.svelte';
  import { capabilities } from '$lib/stores/capabilities.svelte';

  // Admin-set global limits (live via the capabilities store). The bitrate
  // field works in kbps; the admin store holds kbps too.
  let bMin = $derived(capabilities.hqBitrateMinKbps);
  let bMax = $derived(capabilities.hqBitrateMaxKbps);
  let fMin = $derived(capabilities.hqFpsMin);
  let fMax = $derived(capabilities.hqFpsMax);
  let resOptions = $derived(allowedResolutions(capabilities.hqResolutionMax));

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
      bitrate_kbps: isNaN(n) ? undefined : Math.min(bMax, Math.max(bMin, n)),
    };
    persistSettings();
  }

  function onFps(e: Event) {
    const raw = (e.currentTarget as HTMLInputElement).value;
    const n = parseInt(raw, 10);
    streamSettings.overrides = {
      ...streamSettings.overrides,
      fps: isNaN(n) ? undefined : Math.min(fMax, Math.max(fMin, n)),
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
  // Clamp the *displayed* resolution to the admin ceiling so the select never
  // shows a now-disallowed value (e.g. 'Native' after the admin caps to 1080p).
  let resValue = $derived(
    clampResolution(streamSettings.overrides.resolution ?? 'Native', capabilities.hqResolutionMax)
  );

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
      {#each resOptions as r (r)}
        <option value={r}>{r === 'Native' ? 'Native (Bildschirm)' : r}</option>
      {/each}
    </select>
    <p class="text-text-muted text-[11px]">
      {#if capabilities.hqResolutionMax !== 'Native'}
        Vom Server-Admin auf max. {capabilities.hqResolutionMax} begrenzt.
      {:else}
        Nichts über deiner Monitorauflösung wählen — der Encoder skaliert dann nur
        hoch (mehr Bandbreite, kein Detailgewinn).
      {/if}
    </p>
  </div>

  <div class="flex flex-col gap-1.5">
    <Label for="ov-bitrate">Bitrate (kbps)</Label>
    <Input
      id="ov-bitrate"
      type="number"
      min={bMin}
      max={bMax}
      step="500"
      placeholder="z.B. 6000"
      value={bitrateValue}
      oninput={onBitrate}
      data-testid="stream-overrides-bitrate"
    />
    <p class="text-text-muted text-[11px]">Erlaubt: {bMin}–{bMax} kbps.</p>
  </div>

  <div class="flex flex-col gap-1.5">
    <Label for="ov-fps">FPS</Label>
    <Input
      id="ov-fps"
      type="number"
      min={fMin}
      max={fMax}
      step="1"
      placeholder="z.B. 60"
      value={fpsValue}
      oninput={onFps}
      data-testid="stream-overrides-fps"
    />
    <p class="text-text-muted text-[11px]">Erlaubt: {fMin}–{fMax} FPS.</p>
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
