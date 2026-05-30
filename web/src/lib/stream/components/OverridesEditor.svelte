<!--
  OverridesEditor — die zentralen Stream-Einstellungen: Codec, Auflösung,
  Bitrate, FPS. (Hieß historisch "Overrides", weil es früher Profile gab; die
  sind raus — diese vier Werte gehen jetzt direkt an den Encoder.)

  Validierung: Bitrate `HQ_BITRATE_MIN_KBPS`–`HQ_BITRATE_MAX_KBPS` (Cap gegen
  VPS-Bandbreiten-Saturation), FPS 1–360, Auflösung aus dem festen Set,
  Codec aus `CODEC_VALUES`.
-->
<script lang="ts">
  import { Label } from '$lib/components/ui/label/index.js';
  import {
    streamSettings,
    CODEC_VALUES,
    allowedResolutions,
    clampResolution,
    persistSettings,
  } from '../settings.svelte';
  import { capabilities } from '$lib/stores/capabilities.svelte';
  import { m } from '$lib/paraglide/messages.js';

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

  // Hard cap on input (snap the field down so the user can't go above max),
  // enforce the minimum on blur (clamping the min *while* typing would turn a
  // half-typed "2" into the floor). Both write the field's DOM value directly
  // so the displayed number can never exceed the admin ceiling.
  function onBitrate(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    if (el.value === '') {
      streamSettings.overrides = { ...streamSettings.overrides, bitrate_kbps: undefined };
      persistSettings();
      return;
    }
    let n = parseInt(el.value, 10);
    if (isNaN(n)) return;
    if (n > bMax) {
      n = bMax;
      el.value = String(n);
    }
    streamSettings.overrides = { ...streamSettings.overrides, bitrate_kbps: n };
    persistSettings();
  }

  function onBitrateBlur(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    if (el.value === '') return;
    const n = parseInt(el.value, 10);
    if (isNaN(n)) {
      el.value = '';
      return;
    }
    const clamped = Math.min(bMax, Math.max(bMin, n));
    el.value = String(clamped);
    streamSettings.overrides = { ...streamSettings.overrides, bitrate_kbps: clamped };
    persistSettings();
  }

  function onFps(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    if (el.value === '') {
      streamSettings.overrides = { ...streamSettings.overrides, fps: undefined };
      persistSettings();
      return;
    }
    let n = parseInt(el.value, 10);
    if (isNaN(n)) return;
    if (n > fMax) {
      n = fMax;
      el.value = String(n);
    }
    streamSettings.overrides = { ...streamSettings.overrides, fps: n };
    persistSettings();
  }

  function onFpsBlur(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    if (el.value === '') return;
    const n = parseInt(el.value, 10);
    if (isNaN(n)) {
      el.value = '';
      return;
    }
    const clamped = Math.min(fMax, Math.max(fMin, n));
    el.value = String(clamped);
    streamSettings.overrides = { ...streamSettings.overrides, fps: clamped };
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
    <Label for="ov-resolution">{m.overrides_editor_resolution_label()}</Label>
    <select
      id="ov-resolution"
      class="bg-bg-input text-text-base h-9 rounded-md px-2 text-sm outline-none"
      value={resValue}
      onchange={onResolution}
      data-testid="stream-overrides-resolution"
    >
      {#each resOptions as r (r)}
        <option value={r}>{r === 'Native' ? m.overrides_editor_resolution_native() : r}</option>
      {/each}
    </select>
    <p class="text-text-muted text-[11px]">
      {#if capabilities.hqResolutionMax !== 'Native'}
        {m.overrides_editor_resolution_capped({ max: capabilities.hqResolutionMax })}
      {:else}
        {m.overrides_editor_resolution_hint()}
      {/if}
    </p>
  </div>

  <div class="flex flex-col gap-1.5">
    <Label for="ov-bitrate">{m.overrides_editor_bitrate_label()}</Label>
    <input
      id="ov-bitrate"
      class="bg-bg-input text-text-base h-9 rounded-md px-2 text-sm outline-none tabular-nums focus:ring-1 focus:ring-primary"
      type="number"
      min={bMin}
      max={bMax}
      step="500"
      placeholder={m.overrides_editor_bitrate_placeholder()}
      value={bitrateValue}
      oninput={onBitrate}
      onblur={onBitrateBlur}
      data-testid="stream-overrides-bitrate"
    />
    <p class="text-text-muted text-[11px]">{m.overrides_editor_bitrate_range({ min: bMin, max: bMax })}</p>
  </div>

  <div class="flex flex-col gap-1.5">
    <Label for="ov-fps">FPS</Label>
    <input
      id="ov-fps"
      class="bg-bg-input text-text-base h-9 rounded-md px-2 text-sm outline-none tabular-nums focus:ring-1 focus:ring-primary"
      type="number"
      min={fMin}
      max={fMax}
      step="1"
      placeholder={m.overrides_editor_fps_placeholder()}
      value={fpsValue}
      oninput={onFps}
      onblur={onFpsBlur}
      data-testid="stream-overrides-fps"
    />
    <p class="text-text-muted text-[11px]">{m.overrides_editor_fps_range({ min: fMin, max: fMax })}</p>
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
    <span class="text-text-base">{m.overrides_editor_show_cursor()}</span>
  </label>
</div>
