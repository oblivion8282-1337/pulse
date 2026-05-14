<!--
  AudioModePicker — Audio-Quelle für den HQ-Stream:
    Aus · Desktop · Mikrofon · Desktop + Mikrofon · Bestimmte App

  Bei "Desktop"/"Desktop + Mikrofon": darunter die `excluded_apps`-Liste
  (Desktop-Audio minus diese Apps; GSR `app-inverse:`).
  Bei "Bestimmte App": ein Dropdown der laufenden Audio-Apps (live aus
  `gpu-screen-recorder --list-application-audio`) — Auswahl wird als
  `audio_mode = "App: <name>"` gespeichert → Sidecar macht `-a "app:<name>"`.

  Die Refresh-Buttons laden die App-Liste neu.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import RefreshIcon from '@lucide/svelte/icons/refresh-cw';
  import XIcon from '@lucide/svelte/icons/x';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import {
    streamSettings,
    AUDIO_MODES,
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

  let appMode = $derived(isAppAudioMode(streamSettings.audio_mode));
  let usesDesktop = $derived(audioModeUsesDesktop(streamSettings.audio_mode));
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

  function onAppPick(e: Event) {
    const app = (e.currentTarget as HTMLSelectElement).value;
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
  <div class="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Audio-Modus">
    {#each AUDIO_MODES as mode (mode)}
      <Button
        type="button"
        role="radio"
        size="xs"
        variant={streamSettings.audio_mode === mode ? 'default' : 'secondary'}
        aria-checked={streamSettings.audio_mode === mode}
        onclick={() => onModeChange(mode)}
        data-testid="stream-audio-mode-{mode.toLowerCase().replace(/[ +]+/g, '-')}"
      >
        {mode}
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
      Bestimmte App
    </Button>
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
      <select
        class="bg-bg-chat text-text-base h-8 rounded-md px-2 text-xs outline-none"
        value={selectedApp}
        onchange={onAppPick}
        disabled={streamSettings.available_audio_apps.length === 0}
        data-testid="stream-audio-app-pick"
      >
        <option value="">
          {streamSettings.available_audio_apps.length === 0
            ? '(keine laufenden Audio-Apps — Refresh klicken)'
            : 'App auswählen…'}
        </option>
        {#each streamSettings.available_audio_apps as a (a)}
          <option value={a}>{a}</option>
        {/each}
      </select>
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
        Greift nur bei Desktop-Audio. App-spezifische Quellen ignorieren die Liste.
      </p>
    </div>
  {/if}
</div>
