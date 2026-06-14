<script lang="ts">
  import { settings } from '$lib/stores/settings.svelte';
  import type { ThemePreference } from '$lib/stores/settings.svelte';
  import SunIcon from '@lucide/svelte/icons/sun';
  import MoonIcon from '@lucide/svelte/icons/moon';
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import { m } from '$lib/paraglide/messages.js';
  import { changeLocale, currentLocale, availableLocales, localeLabels } from '$lib/i18n';
  import type { Locale } from '$lib/paraglide/runtime';

  const options: { value: ThemePreference; label: () => string; hint: () => string; icon: typeof SunIcon }[] = [
    { value: 'light', label: () => m.settings_appearance_theme_light_label(), hint: () => m.settings_appearance_theme_light_hint(), icon: SunIcon },
    { value: 'dark', label: () => m.settings_appearance_theme_dark_label(), hint: () => m.settings_appearance_theme_dark_hint(), icon: MoonIcon },
    { value: 'system', label: () => m.settings_appearance_theme_system_label(), hint: () => m.settings_appearance_theme_system_hint(), icon: MonitorIcon }
  ];

  // Aktuelle Sprache — `changeLocale` lädt die Seite neu, daher reicht eine
  // einmalige Auswertung beim Render fürs Aktiv-Markieren.
  const activeLocale = currentLocale();
</script>

<div class="flex flex-col gap-5" data-testid="settings-appearance-panel">
  <div class="flex flex-col gap-1">
    <h2 class="text-text-bright text-lg font-semibold">{m.settings_appearance_title()}</h2>
    <p class="text-text-muted text-sm">{m.settings_appearance_subtitle()}</p>
  </div>

  <div class="flex flex-col gap-2">
    <span class="text-text-bright text-sm font-medium">{m.settings_appearance_design_label()}</span>
    <div class="grid grid-cols-3 gap-3">
      {#each options as o (o.value)}
        <button
          type="button"
          onclick={() => settings.setTheme(o.value)}
          class="flex flex-col items-center gap-2 rounded-2xl border p-4 text-center transition-colors {settings
            .appearance.theme === o.value
            ? 'border-primary bg-bg-hover text-text-bright'
            : 'border-border text-text-base hover:bg-bg-hover'}"
          data-testid="appearance-theme-{o.value}"
          aria-pressed={settings.appearance.theme === o.value}
        >
          <span
            class="flex size-10 items-center justify-center rounded-full {settings.appearance.theme === o.value
              ? 'accent-gradient text-white'
              : 'bg-bg-input text-text-muted'}"
          >
            <o.icon class="size-5" />
          </span>
          <span class="text-sm font-medium">{o.label()}</span>
          <span class="text-text-muted text-xs">{o.hint()}</span>
        </button>
      {/each}
    </div>
  </div>

  <div class="flex flex-col gap-2">
    <span class="text-text-bright text-sm font-medium">{m.settings_appearance_language_label()}</span>
    <p class="text-text-muted -mt-1 text-xs">{m.settings_appearance_language_hint()}</p>
    <div class="grid grid-cols-2 gap-3">
      {#each availableLocales as loc (loc)}
        <button
          type="button"
          onclick={() => changeLocale(loc as Locale)}
          class="rounded-2xl border p-3 text-center text-sm font-medium transition-colors {activeLocale ===
          loc
            ? 'border-primary bg-bg-hover text-text-bright'
            : 'border-border text-text-base hover:bg-bg-hover'}"
          data-testid="appearance-locale-{loc}"
          aria-pressed={activeLocale === loc}
        >
          {localeLabels[loc as Locale]}
        </button>
      {/each}
    </div>
  </div>

  <div class="flex flex-col gap-2">
    <span class="text-text-bright text-sm font-medium"
      >{m.settings_appearance_name_colors_label()}</span
    >
    <label class="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={settings.appearance.speakingRingNameColor}
        onchange={(e) => settings.setSpeakingRingNameColor(e.currentTarget.checked)}
        class="size-4"
        data-testid="appearance-speaking-ring-toggle"
      />
      {m.settings_appearance_speaking_ring_label()}
    </label>
    <p class="text-text-muted -mt-1 text-xs">{m.settings_appearance_speaking_ring_hint()}</p>
  </div>
</div>
