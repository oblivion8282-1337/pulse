<script lang="ts">
  /**
   * Namensfarben-Editor für den Profil-Tab: einfarbig oder zwei-Farben-Verlauf
   * mit wählbarer Richtung. Reine Bedien-/Vorschau-Komponente — `bind:`-Props
   * tragen den Zustand zum Eltern-Panel zurück, das Dirty-Tracking + Save macht.
   *
   * Die Verlaufs-Leiste ist (wie Blenders Color Ramp) immer waagerecht, damit
   * man beide Farben sieht; die gewählte Richtung wirkt nur auf den echten
   * Namens-Verlauf — sichtbar in der Live-Vorschau darunter.
   */
  import { gradientTextStyle, NAME_STYLE_PRESETS } from '$lib/utils/nameColor';
  import { m } from '$lib/paraglide/messages.js';
  import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
  import ArrowDownRightIcon from '@lucide/svelte/icons/arrow-down-right';
  import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
  import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';

  let {
    useColor = $bindable(),
    color1 = $bindable(),
    useGradient = $bindable(),
    color2 = $bindable(),
    angle = $bindable(),
    previewName,
  }: {
    useColor: boolean;
    color1: string;
    useGradient: boolean;
    color2: string;
    angle: number;
    previewName: string;
  } = $props();

  // CSS-Winkel: 90° = links→rechts, 135° = ↘, 180° = ↓, 45° = ↗.
  const DIRECTIONS = [
    { deg: 90, icon: ArrowRightIcon },
    { deg: 135, icon: ArrowDownRightIcon },
    { deg: 180, icon: ArrowDownIcon },
    { deg: 45, icon: ArrowUpRightIcon },
  ];

  // Vorschau-Style: identischer Helfer wie der echte Render-Pfad (nameStyle).
  const previewStyle = $derived(
    !useColor
      ? ''
      : useGradient
        ? gradientTextStyle(color1, color2, angle)
        : `color: ${color1}`
  );

  function applyPreset(p: (typeof NAME_STYLE_PRESETS)[number]) {
    useColor = true;
    color1 = p.color1;
    if (p.color2) {
      useGradient = true;
      color2 = p.color2;
      angle = p.angle ?? 90;
    } else {
      useGradient = false;
    }
  }
</script>

<div class="flex flex-col gap-3">
  <span class="text-text-base text-sm font-medium">{m.settings_profile_color_label()}</span>

  <label class="flex items-center gap-2 text-sm">
    <input
      type="checkbox"
      bind:checked={useColor}
      class="size-4"
      data-testid="profile-color-toggle"
    />
    {m.settings_profile_use_color()}
  </label>

  {#if useColor}
    <!-- Verlaufs-/Farbleiste mit Farb-Griffen an den Enden -->
    <div
      class="ramp border-border relative h-10 w-full rounded-lg border"
      style={useGradient
        ? `background-image: linear-gradient(to right, ${color1}, ${color2});`
        : `background-color: ${color1};`}
      data-testid="profile-color-ramp"
    >
      <input
        type="color"
        bind:value={color1}
        class="handle absolute top-1/2 left-1.5 -translate-y-1/2"
        aria-label={m.settings_profile_color_label()}
        data-testid="profile-color-input"
      />
      {#if useGradient}
        <input
          type="color"
          bind:value={color2}
          class="handle absolute top-1/2 right-1.5 -translate-y-1/2"
          aria-label={m.settings_profile_use_gradient()}
          data-testid="profile-color-secondary-input"
        />
      {/if}
    </div>

    <div class="flex flex-wrap gap-1.5" data-testid="name-style-presets">
      {#each NAME_STYLE_PRESETS as p (p.label)}
        <button
          type="button"
          onclick={() => applyPreset(p)}
          title={p.label}
          aria-label={p.label}
          class="border-border size-6 rounded-md border transition-transform hover:scale-110"
          style={p.color2
            ? `background-image: linear-gradient(${p.angle ?? 90}deg, ${p.color1}, ${p.color2});`
            : `background-color: ${p.color1};`}
        ></button>
      {/each}
    </div>

    <label class="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        bind:checked={useGradient}
        class="size-4"
        data-testid="profile-gradient-toggle"
      />
      {m.settings_profile_use_gradient()}
    </label>

    {#if useGradient}
      <div class="flex items-center gap-2">
        <span class="text-text-muted text-xs">{m.settings_profile_gradient_direction()}</span>
        <div class="flex gap-1.5" data-testid="profile-gradient-direction">
          {#each DIRECTIONS as d (d.deg)}
            <button
              type="button"
              onclick={() => (angle = d.deg)}
              class="flex size-8 items-center justify-center rounded-lg border transition-colors {angle ===
              d.deg
                ? 'border-primary bg-bg-hover text-text-bright'
                : 'border-border text-text-muted hover:bg-bg-hover'}"
              aria-pressed={angle === d.deg}
              data-testid="profile-gradient-dir-{d.deg}"
            >
              <d.icon class="size-4" />
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Live-Vorschau des Namens -->
    <div class="flex items-center gap-2">
      <span class="text-text-muted text-xs">{m.settings_profile_color_preview()}:</span>
      <span class="text-base font-semibold" style={previewStyle} data-testid="profile-color-preview">
        {previewName}
      </span>
    </div>
  {/if}
</div>

<style>
  /* Native Color-Inputs als runde Griffe: Default-Chrome entfernen, runder
     Swatch, weißer Ring + Schatten zur Sichtbarkeit auf jeder Farbe. */
  .handle {
    height: 1.75rem;
    width: 1.75rem;
    cursor: pointer;
    border: none;
    border-radius: 9999px;
    padding: 0;
    background: transparent;
    -webkit-appearance: none;
    appearance: none;
    box-shadow:
      0 0 0 2px white,
      0 1px 3px rgba(0, 0, 0, 0.4);
  }
  .handle::-webkit-color-swatch-wrapper {
    padding: 0;
  }
  .handle::-webkit-color-swatch {
    border: none;
    border-radius: 9999px;
  }
  .handle::-moz-color-swatch {
    border: none;
    border-radius: 9999px;
  }
</style>
