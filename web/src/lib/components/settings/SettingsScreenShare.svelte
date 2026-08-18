<script lang="ts">
  import { settings } from '$lib/stores/settings.svelte';
  import type { ScreenShareCodec, ScreenShareResolution } from '$lib/stores/settings.svelte';
  import { capabilities } from '$lib/stores/capabilities.svelte';
  import { allowedNsResolutions, clampNsResolution } from '$lib/settings-registry/sections/screenShare';
  import { m } from '$lib/paraglide/messages.js';
  import { Input } from '$lib/components/ui/input/index.js';

  const codecs: { value: ScreenShareCodec; label: string }[] = [
    { value: 'h264', label: 'H.264' },
    { value: 'av1', label: 'AV1' }
  ];

  const allResolutions: { value: ScreenShareResolution; label: string }[] = [
    { value: 'native', label: m.settings_screenshare_res_native() },
    { value: '1080p', label: m.settings_screenshare_res_1080p() },
    { value: '720p', label: m.settings_screenshare_res_720p() },
    { value: '480p', label: m.settings_screenshare_res_480p() }
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
    // parseFloat, nicht parseInt: der Slider hat step="0.5" — parseInt würde
    // jede Halbstufe (z.B. 2.5) auf den Integer abschneiden, und da value an
    // bitrateMbps gebunden ist, wären alle .5-Positionen unerreichbar.
    const val = parseFloat((e.currentTarget as HTMLInputElement).value);
    if (!isNaN(val)) settings.setScreenShareBitrateMbps(Math.min(bMax, Math.max(bMin, val)));
  }

  function onFpsInput(e: Event) {
    const val = parseInt((e.currentTarget as HTMLInputElement).value, 10);
    if (!isNaN(val)) settings.setScreenShareFps(Math.min(fMax, Math.max(fMin, val)));
  }
</script>

<div class="flex flex-col gap-5" data-testid="settings-screen-share-panel">
  <div class="flex flex-col gap-1">
    <h2 class="text-text-bright text-base font-semibold">{m.settings_screenshare_heading()}</h2>
    <p class="text-text-muted text-xs">{m.settings_screenshare_subheading()}</p>
  </div>

  <section class="flex flex-col gap-2 rounded-2xl border border-border bg-bg-input/40 p-4">
    <span class="text-text-bright text-sm font-medium">{m.settings_screenshare_section_codec()}</span>
    <!-- Nebeneinander statt untereinander, und zwar im selben `grid-cols-2` wie
         der Auflösungs-Block darunter: bei zwei kurzen Bezeichnungen ist eine
         volle Zeile je Eintrag verschenkter Platz, und die beiden Abschnitte
         standen ohne Grund unterschiedlich. -->
    <div class="grid grid-cols-2 gap-1.5">
      {#each codecs as c (c.value)}
        <label class="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-2.5 transition-colors hover:bg-bg-hover md:py-1.5">
          <input
            type="radio"
            name="sss-codec"
            value={c.value}
            checked={settings.screenShare.codec === c.value}
            onchange={() => settings.setScreenShareCodec(c.value)}
            class="accent-primary"
          />
          <span class="text-text-bright text-sm">{c.label}</span>
        </label>
      {/each}
    </div>
  </section>

  <section class="flex flex-col gap-2 rounded-2xl border border-border bg-bg-input/40 p-4">
    <span class="text-text-bright text-sm font-medium">{m.settings_screenshare_section_resolution()}</span>
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
  </section>

  <section class="flex flex-col gap-2 rounded-2xl border border-border bg-bg-input/40 p-4">
    <div class="flex items-center justify-between">
      <span class="text-text-bright text-sm font-medium">{m.settings_screenshare_section_framerate()}</span>
      <span class="text-text-muted text-sm">{m.settings_screenshare_fps_value({ fps: settings.screenShare.fps })}</span>
    </div>
    <Input
      type="number"
      min={fMin}
      max={fMax}
      step="1"
      value={settings.screenShare.fps}
      oninput={onFpsInput}
      class="w-full md:w-24"
      data-testid="screenshare-fps-input"
    />
  </section>

  <section class="flex flex-col gap-2 rounded-2xl border border-border bg-bg-input/40 p-4">
    <div class="flex items-center justify-between">
      <span class="text-text-bright text-sm font-medium">{m.settings_screenshare_section_bitrate()}</span>
      <span class="text-text-muted text-sm">{m.settings_screenshare_bitrate_value({ bitrate: settings.screenShare.bitrateMbps })}</span>
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
  </section>

  <section class="flex flex-col gap-2 rounded-2xl border border-border bg-bg-input/40 p-4">
    <span class="text-text-bright text-sm font-medium">{m.settings_screenshare_section_content_hint()}</span>
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
        <span class="text-text-base text-sm">{m.settings_screenshare_hint_motion()}</span>
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
        <span class="text-text-base text-sm">{m.settings_screenshare_hint_detail()}</span>
      </label>
    </div>
  </section>
</div>
