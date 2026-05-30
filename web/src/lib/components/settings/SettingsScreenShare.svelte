<script lang="ts">
  import { settings } from '$lib/stores/settings.svelte';
  import type { ScreenShareCodec, ScreenShareResolution } from '$lib/stores/settings.svelte';
  import { capabilities } from '$lib/stores/capabilities.svelte';
  import { allowedNsResolutions, clampNsResolution } from '$lib/settings-registry/sections/screenShare';

  const codecs: { value: ScreenShareCodec; label: string; hint: string }[] = [
    { value: 'h264', label: 'H.264', hint: 'Breit kompatibel, Hardware-beschleunigt auf praktisch jedem Setup (NVENC / QuickSync / VideoToolbox)' },
    { value: 'av1', label: 'AV1', hint: 'Beste Qualität bei niedriger Bitrate. HW-Encode nur auf neueren GPUs (Intel ARC, NVIDIA 40-Series, AMD 7000); sonst CPU-only' }
  ];

  const allResolutions: { value: ScreenShareResolution; label: string }[] = [
    { value: 'native', label: 'Nativ (Bildschirmauflösung)' },
    { value: '1080p', label: '1080p (1920×1080)' },
    { value: '720p', label: '720p (1280×720)' },
    { value: '480p', label: '480p (854×480)' }
  ];

  // Admin-set global limits (live via capabilities). Bitrate in Mbit/s.
  let bMin = $derived(capabilities.nsBitrateMinKbps / 1000);
  let bMax = $derived(capabilities.nsBitrateMaxKbps / 1000);
  let fMin = $derived(capabilities.nsFpsMin);
  let fMax = $derived(capabilities.nsFpsMax);
  let allowedRes = $derived(allowedNsResolutions(capabilities.nsResolutionMax));
  let resolutions = $derived(allResolutions.filter((r) => allowedRes.includes(r.value)));

  // Snap stored screen-share settings into the admin band whenever the limits
  // change (or on mount) — keeps the radios/inputs consistent and the labels
  // honest. Converges in one pass (clamped === current → no further write).
  $effect(() => {
    const s = settings.screenShare;
    const f = Math.min(fMax, Math.max(fMin, s.fps));
    if (f !== s.fps) settings.setScreenShareFps(f);
    const b = Math.min(bMax, Math.max(bMin, s.bitrateMbps));
    if (b !== s.bitrateMbps) settings.setScreenShareBitrateMbps(b);
    const r = clampNsResolution(s.resolution, capabilities.nsResolutionMax);
    if (r !== s.resolution) settings.setScreenShareResolution(r);
  });

  function onBitrateInput(e: Event) {
    const val = parseInt((e.currentTarget as HTMLInputElement).value, 10);
    if (!isNaN(val)) settings.setScreenShareBitrateMbps(Math.min(bMax, Math.max(bMin, val)));
  }

  function onFpsInput(e: Event) {
    const val = parseInt((e.currentTarget as HTMLInputElement).value, 10);
    if (!isNaN(val)) settings.setScreenShareFps(Math.min(fMax, Math.max(fMin, val)));
  }
</script>

<div class="flex flex-col gap-5" data-testid="settings-screen-share-panel">
  <p class="text-text-muted text-xs">
    Gilt für den nächsten Start des Teilens. Änderungen werden sofort gespeichert.
  </p>

  <p class="text-text-muted bg-bg-soft rounded-lg px-3 py-2 text-xs">
    <span class="text-text-bright font-medium">Tipp:</span> Wenn du ein Spiel teilst, wähle im
    Picker das <span class="text-text-bright">Fenster</span> des Spiels und aktiviere
    <span class="text-text-bright">„Audio teilen"</span>. Auf Windows 11 mit Chrome oder Edge 141+
    wird so ausschließlich der Spiele-Ton übertragen — die Stimmen der anderen User landen nicht im
    Stream.
  </p>

  <div class="flex flex-col gap-2">
    <span class="text-text-bright text-sm font-medium">Codec</span>
    <div class="flex flex-col gap-1.5">
      {#each codecs as c (c.value)}
        <label class="flex cursor-pointer items-start gap-2.5 rounded-xl px-2 py-2.5 transition-colors hover:bg-bg-hover md:py-1.5">
          <input
            type="radio"
            name="sss-codec"
            value={c.value}
            checked={settings.screenShare.codec === c.value}
            onchange={() => settings.setScreenShareCodec(c.value)}
            class="accent-primary mt-0.5"
          />
          <div>
            <span class="text-text-bright text-sm">{c.label}</span>
            <p class="text-text-muted text-xs">{c.hint}</p>
          </div>
        </label>
      {/each}
    </div>
  </div>

  <div class="flex flex-col gap-2">
    <span class="text-text-bright text-sm font-medium">Auflösung</span>
    <div class="grid grid-cols-2 gap-1.5">
      {#each resolutions as r (r.value)}
        <label class="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-2.5 transition-colors hover:bg-bg-hover md:py-1.5">
          <input
            type="radio"
            name="sss-resolution"
            value={r.value}
            checked={settings.screenShare.resolution === r.value}
            onchange={() => settings.setScreenShareResolution(r.value)}
            class="accent-primary"
          />
          <span class="text-text-base text-sm">{r.label}</span>
        </label>
      {/each}
    </div>
  </div>

  <div class="flex flex-col gap-2">
    <div class="flex items-center justify-between">
      <span class="text-text-bright text-sm font-medium">Framerate</span>
      <span class="text-text-muted text-sm">{settings.screenShare.fps} fps</span>
    </div>
    <input
      type="number"
      min={fMin}
      max={fMax}
      step="1"
      value={settings.screenShare.fps}
      oninput={onFpsInput}
      class="bg-bg-soft border-border-soft text-text-bright focus:border-primary w-full rounded-md border px-2 py-2 text-sm focus:outline-none md:w-24 md:py-1"
      data-testid="screenshare-fps-input"
    />
    <p class="text-text-muted text-xs">
      Erlaubt: {fMin}–{fMax} fps. Werte über 60 hängen stark vom Display-Refresh
      und der GPU/CPU ab — der Encoder unten zeigt dir live, was tatsächlich ankommt.
    </p>
  </div>

  <div class="flex flex-col gap-2">
    <div class="flex items-center justify-between">
      <span class="text-text-bright text-sm font-medium">Bitrate</span>
      <span class="text-text-muted text-sm">{settings.screenShare.bitrateMbps} Mbit/s</span>
    </div>
    <input
      type="range"
      min={bMin}
      max={bMax}
      step="0.5"
      value={settings.screenShare.bitrateMbps}
      oninput={onBitrateInput}
      class="accent-primary h-3 w-full md:h-auto"
      data-testid="screenshare-bitrate-slider"
    />
    <p class="text-text-muted text-xs">
      Höhere Bitrate = bessere Qualität, mehr Bandbreite. Erlaubt: {bMin}–{bMax} Mbit/s.
    </p>
  </div>

  <div class="flex flex-col gap-2">
    <span class="text-text-bright text-sm font-medium">Inhaltstyp</span>
    <div class="flex gap-3">
      <label class="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-2.5 transition-colors hover:bg-bg-hover md:py-1.5">
        <input
          type="radio"
          name="sss-hint"
          value="motion"
          checked={settings.screenShare.contentHint === 'motion'}
          onchange={() => settings.setScreenShareContentHint('motion')}
          class="accent-primary"
        />
        <span class="text-text-base text-sm">Video / Gaming</span>
      </label>
      <label class="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-2.5 transition-colors hover:bg-bg-hover md:py-1.5">
        <input
          type="radio"
          name="sss-hint"
          value="detail"
          checked={settings.screenShare.contentHint === 'detail'}
          onchange={() => settings.setScreenShareContentHint('detail')}
          class="accent-primary"
        />
        <span class="text-text-base text-sm">Text / Code</span>
      </label>
    </div>
  </div>
</div>
