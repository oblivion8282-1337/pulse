<script lang="ts">
  import { settings } from '$lib/stores/settings.svelte';
  import type { ThemePreference } from '$lib/stores/settings.svelte';
  import SunIcon from '@lucide/svelte/icons/sun';
  import MoonIcon from '@lucide/svelte/icons/moon';
  import MonitorIcon from '@lucide/svelte/icons/monitor';

  const options: { value: ThemePreference; label: string; hint: string; icon: typeof SunIcon }[] = [
    { value: 'light', label: 'Hell', hint: 'Glasshouse — luftiges Fast-Weiß', icon: SunIcon },
    { value: 'dark', label: 'Dunkel', hint: 'Gedämpftes Graphit', icon: MoonIcon },
    { value: 'system', label: 'System', hint: 'Folgt deinen Systemeinstellungen', icon: MonitorIcon }
  ];
</script>

<div class="flex flex-col gap-5" data-testid="settings-appearance-panel">
  <div class="flex flex-col gap-1">
    <h2 class="text-text-bright text-lg font-semibold">Erscheinungsbild</h2>
    <p class="text-text-muted text-sm">Wähle, wie Pulse aussehen soll.</p>
  </div>

  <div class="flex flex-col gap-2">
    <span class="text-text-bright text-sm font-medium">Design</span>
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
          <span class="text-sm font-medium">{o.label}</span>
          <span class="text-text-muted text-xs">{o.hint}</span>
        </button>
      {/each}
    </div>
  </div>
</div>
