<!--
  AudioModePicker — vier Modi (Aus / Desktop / Mikrofon / Beides) plus die
  App-Exclude-Liste für Desktop-Audio.

  Wenn Desktop oder "Desktop + Mikrofon" gewählt ist, zeigen wir die
  aktuellen `excluded_apps` als entfernbare Chips an. Darunter eine
  Combobox + "+"-Button um eine neue App aus `available_audio_apps`
  (live aus `gpu-screen-recorder --list-application-audio`) auszuwählen.

  Refresh-Button auf der Audio-App-Liste — entspricht dem `↻` in der
  alten Qt-UI (`_populate_audio_combo` neu aufrufen).
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
    addExcludedApp,
    removeExcludedApp,
    refreshAudioApps,
    audioModeUsesDesktop,
    persistSettings,
    type AudioMode,
  } from '../settings.svelte';

  let pickedToAdd = $state('');
  let refreshing = $state(false);

  let usesDesktop = $derived(audioModeUsesDesktop(streamSettings.audio_mode));
  let availableForAdd = $derived(
    streamSettings.available_audio_apps.filter(
      (a) => !streamSettings.excluded_apps.includes(a),
    ),
  );

  function onModeChange(mode: AudioMode) {
    streamSettings.audio_mode = mode;
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
  </div>

  {#if usesDesktop}
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
        Greift nur bei Desktop-Audio. App-spezifische Quellen ignorieren die Liste
        (GSR-Limitierung).
      </p>
    </div>
  {/if}
</div>
