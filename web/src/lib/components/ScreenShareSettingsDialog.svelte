<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { screenShareSettings } from '$lib/stores/screenShareSettings.svelte';
  import type { ScreenShareCodec, ScreenShareFps, ScreenShareResolution } from '$lib/stores/screenShareSettings.svelte';

  let { open = $bindable(false) }: { open?: boolean } = $props();

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

  let bitrateInput = $state(screenShareSettings.bitrateMbps);

  function onOpenChange(v: boolean) {
    open = v;
  }

  function onBitrateInput(e: Event) {
    const val = parseFloat((e.currentTarget as HTMLInputElement).value);
    if (!isNaN(val)) {
      bitrateInput = val;
      screenShareSettings.setBitrateMbps(val);
    }
  }
</script>

<Dialog.Root {open} {onOpenChange}>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content data-testid="screenshare-settings-dialog">
      <Dialog.Header>
        <Dialog.Title>Bildschirm-Übertragung — Einstellungen</Dialog.Title>
        <Dialog.Description>
          Gilt für den nächsten Start des Teilens. Änderungen werden sofort gespeichert.
        </Dialog.Description>
      </Dialog.Header>

      <div class="flex flex-col gap-5 py-4">
        <!-- Codec -->
        <div class="flex flex-col gap-2">
          <span class="text-text-bright text-sm font-medium">Codec</span>
          <div class="flex flex-col gap-1.5">
            {#each codecs as c (c.value)}
              <label class="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-white/5">
                <input
                  type="radio"
                  name="sss-codec"
                  value={c.value}
                  checked={screenShareSettings.codec === c.value}
                  onchange={() => screenShareSettings.setCodec(c.value)}
                  class="mt-0.5 accent-primary"
                />
                <div>
                  <span class="text-text-bright text-sm">{c.label}</span>
                  <p class="text-text-muted text-xs">{c.hint}</p>
                </div>
              </label>
            {/each}
          </div>
        </div>

        <!-- Auflösung -->
        <div class="flex flex-col gap-2">
          <span class="text-text-bright text-sm font-medium">Auflösung</span>
          <div class="grid grid-cols-2 gap-1.5">
            {#each resolutions as r (r.value)}
              <label class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-white/5">
                <input
                  type="radio"
                  name="sss-resolution"
                  value={r.value}
                  checked={screenShareSettings.resolution === r.value}
                  onchange={() => screenShareSettings.setResolution(r.value)}
                  class="accent-primary"
                />
                <span class="text-text-base text-sm">{r.label}</span>
              </label>
            {/each}
          </div>
        </div>

        <!-- Framerate -->
        <div class="flex flex-col gap-2">
          <span class="text-text-bright text-sm font-medium">Framerate</span>
          <div class="flex gap-3">
            {#each fpsOptions as f (f.value)}
              <label class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-white/5">
                <input
                  type="radio"
                  name="sss-fps"
                  value={f.value}
                  checked={screenShareSettings.fps === f.value}
                  onchange={() => screenShareSettings.setFps(f.value)}
                  class="accent-primary"
                />
                <span class="text-text-base text-sm">{f.label}</span>
              </label>
            {/each}
          </div>
        </div>

        <!-- Bitrate -->
        <div class="flex flex-col gap-2">
          <div class="flex items-center justify-between">
            <span class="text-text-bright text-sm font-medium">Bitrate</span>
            <span class="text-text-muted text-sm">{screenShareSettings.bitrateMbps} Mbit/s</span>
          </div>
          <input
            type="range"
            min="1"
            max="15"
            step="1"
            value={bitrateInput}
            oninput={onBitrateInput}
            class="w-full accent-primary"
            data-testid="screenshare-bitrate-slider"
          />
          <p class="text-text-muted text-xs">Höhere Bitrate = bessere Qualität, mehr Bandbreite.</p>
        </div>

        <!-- Inhaltstyp -->
        <div class="flex flex-col gap-2">
          <span class="text-text-bright text-sm font-medium">Inhaltstyp</span>
          <div class="flex gap-3">
            <label class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-white/5">
              <input
                type="radio"
                name="sss-hint"
                value="motion"
                checked={screenShareSettings.contentHint === 'motion'}
                onchange={() => screenShareSettings.setContentHint('motion')}
                class="accent-primary"
              />
              <span class="text-text-base text-sm">Video / Gaming</span>
            </label>
            <label class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-white/5">
              <input
                type="radio"
                name="sss-hint"
                value="detail"
                checked={screenShareSettings.contentHint === 'detail'}
                onchange={() => screenShareSettings.setContentHint('detail')}
                class="accent-primary"
              />
              <span class="text-text-base text-sm">Text / Code</span>
            </label>
          </div>
        </div>
      </div>

      <Dialog.Footer>
        <Button onclick={() => onOpenChange(false)} data-testid="screenshare-settings-close">
          Schließen
        </Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
