<script lang="ts">
  import { settings } from '$lib/stores/settings.svelte';
  import { sounds } from '$lib/sounds/engine';
  import { SOUNDS, soundsInCategory, type SoundId } from '$lib/sounds/registry';
  import type { SoundCategoryKey } from '$lib/sounds/persistence';
  import PlayIcon from '@lucide/svelte/icons/play';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import BellIcon from '@lucide/svelte/icons/bell';
  import MicIcon from '@lucide/svelte/icons/mic';
  import MousePointerClickIcon from '@lucide/svelte/icons/mouse-pointer-click';
  import { m } from '$lib/paraglide/messages.js';

  type CategoryView = {
    key: SoundCategoryKey;
    title: string;
    hint: string;
    icon: typeof BellIcon;
  };

  const categories: CategoryView[] = [
    {
      key: 'notification',
      title: m.settings_sounds_category_notification_title(),
      hint: m.settings_sounds_category_notification_hint(),
      icon: BellIcon
    },
    {
      key: 'voice',
      title: m.settings_sounds_category_voice_title(),
      hint: m.settings_sounds_category_voice_hint(),
      icon: MicIcon
    },
    {
      key: 'ui',
      title: m.settings_sounds_category_ui_title(),
      hint: m.settings_sounds_category_ui_hint(),
      icon: MousePointerClickIcon
    }
  ];

  function pct(v: number): string {
    return `${Math.round(v * 100)}%`;
  }

  function onMasterVolume(e: Event) {
    const v = Number((e.currentTarget as HTMLInputElement).value) / 100;
    settings.setSoundsMasterVolume(v);
  }

  function onCategoryVolume(cat: SoundCategoryKey, e: Event) {
    const v = Number((e.currentTarget as HTMLInputElement).value) / 100;
    settings.setSoundCategoryVolume(cat, v);
  }

  function soundsFor(cat: SoundCategoryKey): SoundId[] {
    return soundsInCategory(cat);
  }
</script>

<div class="flex flex-col gap-5" data-testid="settings-sounds-panel">
  <div class="flex flex-col gap-1">
    <h2 class="text-text-bright text-lg font-semibold">Sounds</h2>
    <p class="text-text-muted text-sm">
      {m.settings_sounds_description()}
    </p>
  </div>

  <section
    class="flex flex-col gap-3 rounded-2xl border border-border bg-bg-input/40 p-4"
    data-testid="sounds-master"
  >
    <label class="flex items-center justify-between gap-3 text-sm">
      <span class="flex items-center gap-2">
        <Volume2Icon class="text-text-muted size-4" />
        <span class="flex flex-col">
          <span class="text-text-bright">{m.settings_sounds_master_enabled_label()}</span>
          <span class="text-text-muted text-xs">{m.settings_sounds_master_enabled_hint()}</span>
        </span>
      </span>
      <input
        type="checkbox"
        class="size-5 accent-[var(--brand)] md:size-4"
        checked={settings.sounds.masterEnabled}
        onchange={(e) =>
          settings.setSoundsMasterEnabled((e.currentTarget as HTMLInputElement).checked)}
        data-testid="sounds-master-toggle"
      />
    </label>

    <label class="flex flex-col gap-1.5 text-sm">
      <span class="flex items-center justify-between">
        <span class="text-text-bright">{m.settings_sounds_volume_label()}</span>
        <span class="text-text-muted text-xs tabular-nums">{pct(settings.sounds.masterVolume)}</span>
      </span>
      <input
        type="range"
        min="0"
        max="100"
        step="1"
        value={Math.round(settings.sounds.masterVolume * 100)}
        oninput={onMasterVolume}
        disabled={!settings.sounds.masterEnabled}
        class="h-3 accent-[var(--brand)] disabled:opacity-50 md:h-auto"
        data-testid="sounds-master-volume"
      />
    </label>
  </section>

  {#each categories as cat (cat.key)}
    {@const catSettings = settings.sounds[cat.key]}
    {@const dimmed = !settings.sounds.masterEnabled || !catSettings.enabled}
    <section
      class="flex flex-col gap-3 rounded-2xl border border-border bg-bg-input/40 p-4"
      data-testid="sounds-category-{cat.key}"
    >
      <div class="flex items-start justify-between gap-3">
        <span class="flex items-center gap-2">
          <cat.icon class="text-text-muted size-4" />
          <span class="flex flex-col">
            <span class="text-text-bright text-sm font-medium">{cat.title}</span>
            <span class="text-text-muted text-xs">{cat.hint}</span>
          </span>
        </span>
        <input
          type="checkbox"
          class="size-5 shrink-0 accent-[var(--brand)] md:size-4"
          checked={catSettings.enabled}
          disabled={!settings.sounds.masterEnabled}
          onchange={(e) =>
            settings.setSoundCategoryEnabled(
              cat.key,
              (e.currentTarget as HTMLInputElement).checked
            )}
          data-testid="sounds-category-{cat.key}-toggle"
        />
      </div>

      <label class="flex flex-col gap-1.5 text-sm">
        <span class="flex items-center justify-between">
          <span class="text-text-bright">{m.settings_sounds_volume_label()}</span>
          <span class="text-text-muted text-xs tabular-nums">{pct(catSettings.volume)}</span>
        </span>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value={Math.round(catSettings.volume * 100)}
          oninput={(e) => onCategoryVolume(cat.key, e)}
          disabled={dimmed}
          class="h-3 accent-[var(--brand)] disabled:opacity-50 md:h-auto"
          data-testid="sounds-category-{cat.key}-volume"
        />
      </label>

      <div class="flex flex-col gap-1">
        {#each soundsFor(cat.key) as id (id)}
          {@const missing = sounds.isMissing(id)}
          <div
            class="flex items-center justify-between gap-2 rounded-lg bg-bg-input/40 px-2 py-1.5 text-sm"
            data-testid="sounds-item-{id}"
          >
            <span class="text-text-base truncate {dimmed ? 'opacity-60' : ''}">
              {SOUNDS[id].label}
            </span>
            <button
              type="button"
              onclick={() => sounds.test(id)}
              disabled={missing || !settings.sounds.masterEnabled}
              title={missing ? m.settings_sounds_file_missing() : m.settings_sounds_preview()}
              class="hover:bg-bg-hover shrink-0 rounded-md p-2.5 text-text-muted hover:text-text-bright transition-colors disabled:cursor-not-allowed disabled:opacity-30 md:p-1"
              data-testid="sounds-test-{id}"
              aria-label={m.settings_sounds_preview_aria({ label: SOUNDS[id].label })}
            >
              <PlayIcon class="size-3.5" />
            </button>
          </div>
        {/each}
      </div>
    </section>
  {/each}
</div>
