<!--
  AvOffsetSlider — Windows-only Feintuning für den Bild/Ton-Versatz (Lippensync).

  Der Windows-HQ-Sidecar verankert Bild und Ton an einer gemeinsamen Hardware-
  Uhr (QPC), wodurch der variable Teil des Versatzes wegfällt. Ein kleiner
  konstanter Rest bleibt (Bild nimmt den längeren Weg über Encode + Decode) —
  den gleicht dieser Wert aus: positiv = Ton später (Standardfall, wenn der Ton
  vor dem Bild liegt), negativ = Ton früher.

  Der Wert reist im `start`-Request als `av_offset_ms` zum Sidecar. Greift erst
  beim nächsten Stream-Start (Stream stoppen, Wert ändern, neu starten).

  Auf Linux wird die Komponente nicht eingebunden (StreamPanel gated auf
  isWindows()) — gpu-screen-recorder synchronisiert dort selbst.
-->
<script lang="ts">
  import { Label } from '$lib/components/ui/label/index.js';
  import { streamSettings, persistSettings } from '../settings.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button';

  // Symmetrischer Bereich; ±500ms deckt jeden realistischen Lippensync-Rest ab.
  const MIN = -500;
  const MAX = 500;
  const STEP = 5;

  function clamp(n: number): number {
    return Math.min(MAX, Math.max(MIN, Math.round(n)));
  }

  function set(v: number) {
    streamSettings.av_offset_ms = clamp(v);
    persistSettings();
  }

  function onRange(e: Event) {
    set(Number((e.currentTarget as HTMLInputElement).value));
  }

  function onNumber(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    if (el.value === '') return;
    const n = Number(el.value);
    if (Number.isNaN(n)) return;
    set(n);
  }

  function onNumberBlur(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    el.value = String(streamSettings.av_offset_ms);
  }
</script>

<div class="flex flex-col gap-1.5" data-testid="stream-av-offset">
  <div class="flex items-center justify-between gap-2">
    <Label for="av-offset">{m.av_offset_label()}</Label>
    <div class="flex items-center gap-1.5">
      <input
        id="av-offset-num"
        class="bg-bg-input text-text-base h-8 w-20 rounded-md px-2 text-right text-sm outline-none tabular-nums focus:ring-1 focus:ring-primary"
        type="number"
        min={MIN}
        max={MAX}
        step={STEP}
        value={streamSettings.av_offset_ms}
        oninput={onNumber}
        onblur={onNumberBlur}
        data-testid="stream-av-offset-number"
      />
      <span class="text-text-muted text-xs">ms</span>
      {#if streamSettings.av_offset_ms !== 0}
        <Button
          variant="link"
          size="xs"
          onclick={() => set(0)}
          data-testid="stream-av-offset-reset"
        >
          {m.av_offset_reset()}
        </Button>
      {/if}
    </div>
  </div>
  <input
    id="av-offset"
    class="accent-primary h-1.5 w-full cursor-pointer"
    type="range"
    min={MIN}
    max={MAX}
    step={STEP}
    value={streamSettings.av_offset_ms}
    oninput={onRange}
    data-testid="stream-av-offset-range"
  />
  <p class="text-text-muted text-[11px]">{m.av_offset_hint()}</p>
</div>
