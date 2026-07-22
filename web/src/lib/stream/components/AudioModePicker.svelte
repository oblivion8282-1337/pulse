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
  import LockIcon from '@lucide/svelte/icons/lock';
  import { isWindows } from '$lib/platform/runtime';
  import { m } from '$lib/paraglide/messages.js';
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

  // Mirror of the sidecar's PULSE_SELF_NODE_NAME (profiles.py): Pulse's own
  // audio node is ALWAYS excluded from system-audio capture (the sidecar adds
  // app-inverse:Pulse) to prevent the voice echo. The UI shows it as a pinned,
  // non-removable chip and hides it from the add-list — no manual step needed.
  const PULSE_SELF_NODE_NAME = 'Pulse';

  let pickedToAdd = $state('');
  let refreshing = $state(false);

  // Internal value → UI-Label.
  function label(mode: AudioMode): string {
    if (mode === 'Desktop') return m.audio_mode_picker_system();
    if (mode === 'Desktop + Mikrofon') return m.audio_mode_picker_system_plus_mic();
    if (mode === 'Mikrofon') return m.audio_mode_picker_mic_only();
    if (mode === 'Aus') return m.audio_mode_picker_off();
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
  let secondaryLabel = $derived(
    SECONDARY_MODES.includes(streamSettings.audio_mode as AudioMode)
      ? label(streamSettings.audio_mode as AudioMode)
      : '',
  );
  let selectedApp = $derived(appFromAudioMode(streamSettings.audio_mode) || streamSettings.audio_app);
  // Auswahl-Knöpfe = laufende Audio-Sitzungen PLUS die aktuell gewählte App,
  // falls die gerade keine hat. Nötig seit die Fenster-Auswahl den Ton
  // automatisch mitsetzt: `list_application_audio` zählt nur Anwendungen mit
  // aktiver Audio-Sitzung auf, ein gerade stilles Spiel steht also nicht drin —
  // ohne diese Ergänzung wäre kein Knopf hervorgehoben und die Vorauswahl
  // unsichtbar, obwohl sie gesetzt ist (und beim Start auch greift).
  let appPills = $derived(
    selectedApp && !streamSettings.available_audio_apps.includes(selectedApp)
      ? [selectedApp, ...streamSettings.available_audio_apps]
      : streamSettings.available_audio_apps,
  );
  let availableForAdd = $derived(
    streamSettings.available_audio_apps.filter(
      (a) => !streamSettings.excluded_apps.includes(a) && a !== PULSE_SELF_NODE_NAME,
    ),
  );

  function modeSlug(mode: string): string {
    return mode.toLowerCase().replace(/[ +]+/g, '-');
  }

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
    // Wird die App-Liste neu geladen, während eine Auswahl im <select> ansteht,
    // verschwindet die gewählte App ggf. aus den Optionen — der Browser zeigt
    // dann den Platzhalter, aber bind:value (change-event-getrieben) lässt
    // pickedToAdd stehen. Ohne diesen Guard schließt "Hinzufügen" eine stale,
    // nicht mehr sichtbar gewählte App aus. Nur ausschließen, wenn weiterhin gültig.
    if (!pickedToAdd || !availableForAdd.includes(pickedToAdd)) {
      pickedToAdd = '';
      return;
    }
    addExcludedApp(pickedToAdd);
    pickedToAdd = '';
  }
</script>

<div class="flex flex-col gap-2" data-testid="stream-audio-picker">
  <Label>Audio</Label>
  <div class="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={m.audio_mode_picker_audio_mode_label()}>
    {#each MAIN_MODES as mode (mode)}
      <Button
        type="button"
        role="radio"
        size="xs"
        variant={streamSettings.audio_mode === mode ? 'default' : 'secondary'}
        aria-checked={streamSettings.audio_mode === mode}
        onclick={() => onModeChange(mode)}
        data-testid="stream-audio-mode-{modeSlug(mode)}"
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
      {m.audio_mode_picker_specific_app()}
    </Button>

    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            type="button"
            size="xs"
            variant={!!secondaryLabel ? 'default' : 'ghost'}
            aria-label={m.audio_mode_picker_more_options()}
            title={secondaryLabel || m.audio_mode_picker_more_options()}
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
            data-testid="stream-audio-mode-{modeSlug(mode)}"
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
        <span class="text-text-bright text-xs font-medium">{m.audio_mode_picker_select_app()}</span>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onclick={onRefresh}
          disabled={refreshing}
          data-testid="stream-audio-refresh-apps"
          aria-label={m.audio_mode_picker_refresh_app_list()}
        >
          <RefreshIcon class="size-3 {refreshing ? 'animate-spin' : ''}" />
          Refresh
        </Button>
      </div>
      {#if appPills.length === 0}
        <p class="text-text-muted text-xs italic">
          {m.audio_mode_picker_no_running_apps()}
        </p>
      {:else}
        <div class="flex flex-wrap gap-1.5" data-testid="stream-audio-app-pills">
          {#each appPills as app (app)}
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
        <p class="text-warning/90 text-xs">{m.audio_mode_picker_select_app_before_stream()}</p>
      {/if}
    </div>
    <!-- Windows: WASAPI process-loopback can exclude only ONE process tree, and
         that single slot is spent on Pulse itself (the echo fix) — user-chosen
         excludes can't be honored. So the whole exclude box is dropped on
         Windows (Pulse stays auto-excluded silently in the sidecar); only Linux
         shows it. -->
  {:else if usesDesktop && !isWindows()}
    <div class="bg-bg-input mt-1 flex flex-col gap-2 rounded-xl border border-border p-2.5">
      <div class="flex items-center justify-between">
        <span class="text-text-bright text-xs font-medium">{m.audio_mode_picker_exclude_apps()}</span>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onclick={onRefresh}
          disabled={refreshing}
          data-testid="stream-audio-refresh"
          aria-label={m.audio_mode_picker_refresh_app_list()}
        >
          <RefreshIcon class="size-3 {refreshing ? 'animate-spin' : ''}" />
          Refresh
        </Button>
      </div>

      <div class="flex flex-wrap gap-1.5" data-testid="stream-audio-excluded-list">
        <!-- Pulse's own audio is ALWAYS excluded from system capture (the
             sidecar adds app-inverse:Pulse) so voice playback isn't recaptured
             → echo. Pinned + non-removable, so it's visibly automatic. -->
        <span
          class="bg-bg-chat text-text-muted inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-xs"
          data-testid="stream-audio-auto-excluded"
          title={m.audio_mode_picker_pulse_auto_hint()}
        >
          <LockIcon class="size-3 opacity-60" />
          {PULSE_SELF_NODE_NAME}
        </span>
        {#each streamSettings.excluded_apps.filter((a) => a !== PULSE_SELF_NODE_NAME) as app (app)}
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
              aria-label={m.audio_mode_picker_remove_app({ app })}
            >
              <XIcon class="size-3" />
            </Button>
          </span>
        {/each}
      </div>

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
                ? m.audio_mode_picker_no_running_apps()
                : m.audio_mode_picker_all_excluded()
              : m.audio_mode_picker_select_app_placeholder()}
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
          {m.audio_mode_picker_add()}
        </Button>
      </div>
      <p class="text-text-muted text-xs">
        {m.audio_mode_picker_exclude_hint()}
      </p>
    </div>
  {/if}
</div>
