<!--
  AudioModePicker — Audio-Quelle für den HQ-Stream.

  Layout: drei Haupt-Optionen als Pills (Aus · System · Spezifische App) +
  ein Chevron-Button daneben, dessen Popover die selteneren Mikro-Optionen
  enthält (Nur Mikrofon · System + Mikrofon).

  Interne Modus-Werte bleiben unverändert (`Desktop`, `Mikrofon`,
  `Desktop + Mikrofon`) — der Sidecar (`profiles.py::_AUDIO_LABEL_TO_BASE`)
  erwartet genau diese Strings. Die UI mappt sie nur in lesbarere Labels.

  Bei "System"/"System + Mikrofon": darunter die `excluded_apps`-Liste
  (System-Audio minus diese Apps; GSR `app-inverse:`).
  Bei "Spezifische App": Pills der laufenden Audio-Apps (live aus
  `gpu-screen-recorder --list-application-audio`) — Auswahl wird als
  `audio_mode = "App: <name>"` gespeichert → Sidecar macht `-a "app:<name>"`.

  Die Refresh-Buttons laden die App-Liste neu.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import RefreshIcon from '@lucide/svelte/icons/refresh-cw';
  import XIcon from '@lucide/svelte/icons/x';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import { isWindows } from '$lib/platform/runtime';
  import {
    streamSettings,
    APP_AUDIO_PREFIX,
    isAppAudioMode,
    appFromAudioMode,
    addExcludedApp,
    removeExcludedApp,
    refreshAudioApps,
    audioModeUsesDesktop,
    persistSettings,
    type AudioMode,
  } from '../settings.svelte';

  let pickedToAdd = $state('');
  let refreshing = $state(false);

  // Internal value → UI-Label.
  function label(mode: AudioMode): string {
    if (mode === 'Desktop') return 'System';
    if (mode === 'Desktop + Mikrofon') return 'System + Mikrofon';
    if (mode === 'Mikrofon') return 'Nur Mikrofon';
    return mode;
  }

  const MAIN_MODES: AudioMode[] = ['Aus', 'Desktop'];
  // "System + Mikrofon" braucht den Stage-7-Mixer, den der Windows-Sidecar
  // nicht hat (`AudioSource::DesktopPlusMicrophone` = TODO-Stub). Dort nur
  // "Nur Mikrofon" anbieten — ein verhungernder Audio-Stream crasht sonst den
  // Muxer (s. settings.svelte.ts::applyPersisted für den persistierten Wert).
  const SECONDARY_MODES: AudioMode[] = isWindows()
    ? ['Mikrofon']
    : ['Mikrofon', 'Desktop + Mikrofon'];

  let appMode = $derived(isAppAudioMode(streamSettings.audio_mode));
  let usesDesktop = $derived(audioModeUsesDesktop(streamSettings.audio_mode));
  let secondaryActive = $derived(
    SECONDARY_MODES.includes(streamSettings.audio_mode as AudioMode),
  );
  let secondaryLabel = $derived(
    secondaryActive ? label(streamSettings.audio_mode as AudioMode) : '',
  );
  let selectedApp = $derived(appFromAudioMode(streamSettings.audio_mode) || streamSettings.audio_app);
  let availableForAdd = $derived(
    streamSettings.available_audio_apps.filter((a) => !streamSettings.excluded_apps.includes(a)),
  );

  function onModeChange(mode: AudioMode) {
    streamSettings.audio_mode = mode;
    persistSettings();
  }

  function onAppModeClick() {
    const app = streamSettings.audio_app || streamSettings.available_audio_apps[0] || '';
    if (app) streamSettings.audio_app = app;
    streamSettings.audio_mode = APP_AUDIO_PREFIX + app;
    persistSettings();
  }

  function onAppPick(app: string) {
    if (!app) return;
    streamSettings.audio_app = app;
    streamSettings.audio_mode = APP_AUDIO_PREFIX + app;
    persistSettings();
  }

  async function onRefresh() {
    refreshing = true;
    try {
      await refreshAudioApps();
    } finally {
      refreshing = false;
    }
  }

  function onAdd() {
    if (!pickedToAdd) return;
    addExcludedApp(pickedToAdd);
    pickedToAdd = '';
  }
</script>

<div class="flex flex-col gap-2" data-testid="stream-audio-picker">
  <Label>Audio</Label>
  <div class="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Audio-Modus">
    {#each MAIN_MODES as mode (mode)}
      <Button
        type="button"
        role="radio"
        size="xs"
        variant={streamSettings.audio_mode === mode ? 'default' : 'secondary'}
        aria-checked={streamSettings.audio_mode === mode}
        onclick={() => onModeChange(mode)}
        data-testid="stream-audio-mode-{mode.toLowerCase().replace(/[ +]+/g, '-')}"
      >
        {label(mode)}
      </Button>
    {/each}
    <Button
      type="button"
      role="radio"
      size="xs"
      variant={appMode ? 'default' : 'secondary'}
      aria-checked={appMode}
      onclick={onAppModeClick}
      data-testid="stream-audio-mode-app"
    >
      Spezifische App
    </Button>

    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            type="button"
            size="xs"
            variant={secondaryActive ? 'default' : 'ghost'}
            aria-label="Weitere Audio-Optionen"
            title={secondaryLabel || 'Weitere Audio-Optionen'}
            data-testid="stream-audio-secondary-trigger"
          >
            <ChevronDownIcon class="size-3.5" />
          </Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="start" sideOffset={4}>
        {#each SECONDARY_MODES as mode (mode)}
          <DropdownMenu.Item
            onclick={() => onModeChange(mode)}
            data-testid="stream-audio-mode-{mode.toLowerCase().replace(/[ +]+/g, '-')}"
          >
            {#if streamSettings.audio_mode === mode}
              <span aria-hidden="true">✓</span>
            {/if}
            {label(mode)}
          </DropdownMenu.Item>
        {/each}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>

  {#if appMode}
    <div class="bg-bg-input mt-1 flex flex-col gap-2 rounded-xl border border-border p-2.5">
      <div class="flex items-center justify-between">
        <span class="text-text-bright text-xs font-medium">App auswählen</span>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onclick={onRefresh}
          disabled={refreshing}
          data-testid="stream-audio-refresh-apps"
          aria-label="App-Liste neu laden"
        >
          <RefreshIcon class="size-3 {refreshing ? 'animate-spin' : ''}" />
          Refresh
        </Button>
      </div>
      {#if streamSettings.available_audio_apps.length === 0}
        <p class="text-text-muted text-xs italic">
          (keine laufenden Audio-Apps — Refresh klicken)
        </p>
      {:else}
        <div class="flex flex-wrap gap-1.5" data-testid="stream-audio-app-pills">
          {#each streamSettings.available_audio_apps as app (app)}
            <Button
              type="button"
              size="xs"
              variant={selectedApp === app ? 'default' : 'secondary'}
              onclick={() => onAppPick(app)}
              data-testid="stream-audio-app-pill"
            >
              {app}
            </Button>
          {/each}
        </div>
      {/if}
      {#if !selectedApp}
        <p class="text-amber-400/90 text-xs">Wähle eine App, bevor du den Stream startest.</p>
      {/if}
    </div>
  {:else if usesDesktop}
    <div class="bg-bg-input mt-1 flex flex-col gap-2 rounded-xl border border-border p-2.5">
      <div class="flex items-center justify-between">
        <span class="text-text-bright text-xs font-medium">Apps ausschließen</span>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onclick={onRefresh}
          disabled={refreshing}
          data-testid="stream-audio-refresh"
          aria-label="App-Liste neu laden"
        >
          <RefreshIcon class="size-3 {refreshing ? 'animate-spin' : ''}" />
          Refresh
        </Button>
      </div>

      {#if streamSettings.excluded_apps.length === 0}
        <p class="text-text-muted text-xs italic">Keine Apps ausgeschlossen.</p>
      {:else}
        <div class="flex flex-wrap gap-1.5" data-testid="stream-audio-excluded-list">
          {#each streamSettings.excluded_apps as app (app)}
            <span
              class="bg-bg-chat text-text-bright inline-flex items-center gap-1 rounded-full border border-border py-0.5 pr-0.5 pl-2 text-xs"
            >
              <span class="max-w-[14ch] truncate">{app}</span>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                class="hover:text-destructive size-4 rounded-full"
                onclick={() => removeExcludedApp(app)}
                aria-label={`${app} entfernen`}
              >
                <XIcon class="size-3" />
              </Button>
            </span>
          {/each}
        </div>
      {/if}

      <div class="flex items-center gap-2">
        <select
          class="bg-bg-chat text-text-base h-8 flex-1 rounded-md px-2 text-xs outline-none"
          bind:value={pickedToAdd}
          disabled={availableForAdd.length === 0}
          data-testid="stream-audio-app-select"
        >
          <option value="">
            {availableForAdd.length === 0
              ? streamSettings.available_audio_apps.length === 0
                ? '(keine laufenden Audio-Apps — Refresh klicken)'
                : '(alle bereits ausgeschlossen)'
              : 'App auswählen…'}
          </option>
          {#each availableForAdd as a (a)}
            <option value={a}>{a}</option>
          {/each}
        </select>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onclick={onAdd}
          disabled={!pickedToAdd}
          data-testid="stream-audio-app-add"
        >
          <PlusIcon class="size-3.5" />
          Hinzufügen
        </Button>
      </div>
      <p class="text-text-muted text-xs">
        Greift nur bei System-Audio. App-spezifische Quellen ignorieren die Liste.
      </p>
    </div>
  {/if}
</div>
