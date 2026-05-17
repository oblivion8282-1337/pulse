<script lang="ts">
  import { settings, SCREEN_SHARE_BITRATE_MIN, SCREEN_SHARE_BITRATE_MAX } from '$lib/stores/settings.svelte';
  import type { ScreenShareCodec, ScreenShareFps, ScreenShareResolution } from '$lib/stores/settings.svelte';

  const codecs: { value: ScreenShareCodec; label: string; hint: string }[] = [
    { value: 'vp9', label: 'VP9', hint: 'Guter Standard, breite Unterstützung' },
    { value: 'vp8', label: 'VP8', hint: 'Maximale Kompatibilität' },
    { value: 'h264', label: 'H.264', hint: 'Breit kompatibel, Hardware-beschleunigt' },
    { value: 'av1', label: 'AV1', hint: 'Beste Qualität bei niedriger Bitrate, aber CPU-intensiv — nicht in allen Browsern' }
  ];

  const resolutions: { value: ScreenShareResolution; label: string }[] = [
    { value: 'native', label: 'Nativ (Bildschirmauflösung)' },
    { value: '1080p', label: '1080p (1920×1080)' },
    { value: '720p', label: '720p (1280×720)' },
    { value: '480p', label: '480p (854×480)' }
  ];

  const fpsOptions: { value: ScreenShareFps; label: string }[] = [
    { value: 15, label: '15 fps' },
    { value: 30, label: '30 fps' },
    { value: 60, label: '60 fps' }
  ];

  function onBitrateInput(e: Event) {
    const val = parseInt((e.currentTarget as HTMLInputElement).value, 10);
    if (!isNaN(val)) settings.setScreenShareBitrateMbps(val);
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
        <label class="flex cursor-pointer items-start gap-2.5 rounded-xl px-2 py-1.5 transition-colors hover:bg-bg-hover">
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
        <label class="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 transition-colors hover:bg-bg-hover">
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
    <span class="text-text-bright text-sm font-medium">Framerate</span>
    <div class="flex gap-3">
      {#each fpsOptions as f (f.value)}
        <label class="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 transition-colors hover:bg-bg-hover">
          <input
            type="radio"
            name="sss-fps"
            value={f.value}
            checked={settings.screenShare.fps === f.value}
            onchange={() => settings.setScreenShareFps(f.value)}
            class="accent-primary"
          />
          <span class="text-text-base text-sm">{f.label}</span>
        </label>
      {/each}
    </div>
  </div>

  <div class="flex flex-col gap-2">
    <div class="flex items-center justify-between">
      <span class="text-text-bright text-sm font-medium">Bitrate</span>
      <span class="text-text-muted text-sm">{settings.screenShare.bitrateMbps} Mbit/s</span>
    </div>
    <input
      type="range"
      min={SCREEN_SHARE_BITRATE_MIN}
      max={SCREEN_SHARE_BITRATE_MAX}
      step="1"
      value={settings.screenShare.bitrateMbps}
      oninput={onBitrateInput}
      class="accent-primary w-full"
      data-testid="screenshare-bitrate-slider"
    />
    <p class="text-text-muted text-xs">Höhere Bitrate = bessere Qualität, mehr Bandbreite.</p>
  </div>

  <div class="flex flex-col gap-2">
    <span class="text-text-bright text-sm font-medium">Inhaltstyp</span>
    <div class="flex gap-3">
      <label class="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 transition-colors hover:bg-bg-hover">
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
      <label class="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 transition-colors hover:bg-bg-hover">
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
