<script module lang="ts">
  // Exportiert, damit Call-Sites (uiOverlays.openSettings) typsicher einen
  // Ziel-Tab benennen können.
  export type SettingsTab =
    | 'profile'
    | 'appearance'
    | 'audio-video'
    | 'screen-share'
    | 'notifications'
    | 'sounds'
    | 'keyboard'
    | 'security'
    | 'privacy'
    | 'self-host'
    | 'apps'
    | 'diagnostics';
</script>

<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import SettingsAppearance from './settings/SettingsAppearance.svelte';
  import SettingsAudioVideo from './settings/SettingsAudioVideo.svelte';
  import SettingsScreenShare from './settings/SettingsScreenShare.svelte';
  import SettingsNotifications from './settings/SettingsNotifications.svelte';
  import SettingsSounds from './settings/SettingsSounds.svelte';
  import SettingsSecurity from './settings/SettingsSecurity.svelte';
  import SettingsKeyboard from './settings/SettingsKeyboard.svelte';
  import SettingsPrivacy from './settings/SettingsPrivacy.svelte';
  import SettingsProfile from './settings/SettingsProfile.svelte';
  import SettingsSelfHost from './settings/SettingsSelfHost.svelte';
  import SettingsApps from './settings/SettingsApps.svelte';
  import SettingsDiagnostics from './settings/SettingsDiagnostics.svelte';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import PlugZapIcon from '@lucide/svelte/icons/plug-zap';
  import PaletteIcon from '@lucide/svelte/icons/palette';
  import MicIcon from '@lucide/svelte/icons/mic';
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import BellIcon from '@lucide/svelte/icons/bell';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import KeyboardIcon from '@lucide/svelte/icons/keyboard';
  import ShieldIcon from '@lucide/svelte/icons/shield';
  import LockIcon from '@lucide/svelte/icons/lock';
  import ServerIcon from '@lucide/svelte/icons/server';
  import UserIcon from '@lucide/svelte/icons/user';
  import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
  import { untrack } from 'svelte';
  import { sounds } from '$lib/sounds/engine';
  import { isCapacitorAndroid, isElectron } from '$lib/platform/runtime';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button';

  type MobileView = 'list' | 'detail';

  let {
    open = $bindable(false),
    initialTab = 'audio-video'
  }: { open?: boolean; initialTab?: SettingsTab } = $props();

  let activeTab = $state<SettingsTab>('audio-video');
  let mobileView = $state<MobileView>('list');

  // Jump to the requested tab whenever the dialog is (re)opened. `initialTab`
  // is read untracked so a parent-driven re-bind mid-open doesn't re-fire the
  // open-sound or clobber the user's current tab choice.
  $effect(() => {
    if (open) {
      untrack(() => {
        // Fallback, wenn der gewünschte Tab hier nicht angeboten wird
        // (desktopOnly auf Mobil, browserOnly in Electron/Capacitor).
        const hidden =
          (viewport.isMobile && tabs.some((t) => t.id === initialTab && t.desktopOnly)) ||
          (!inBrowser && tabs.some((t) => t.id === initialTab && t.browserOnly));
        activeTab = hidden ? 'audio-video' : initialTab;
        mobileView = 'list';
        sounds.play('ui.modal_open');
      });
    }
  });

  function selectTab(id: SettingsTab) {
    activeTab = id;
    mobileView = 'detail';
  }

  // browserOnly: in der Electron-App / im Android-Wrapper ausgeblendet —
  // dort ist die App schon installiert, Download-Links wären sinnlos.
  const inBrowser = !isElectron() && !isCapacitorAndroid();

  // electronOnly: jede Desktop-App, egal welche Plattform. Im Browser gibt es
  // keinen lokalen Sidecar und keine `sidecar.log`, dort gäbe es also nichts
  // einzustellen.
  //
  // **Hier stand bis 2026-08-06 `linuxOnly`**, aus der Zeit, als der Tab nur
  // den Rust-Linux-Sidecar umschaltete. Seit der Diagnose-Schalter darin sitzt,
  // war das ein stiller Ausschluss: Windows- und macOS-Nutzer sahen den Tab
  // nicht, konnten die Einwilligung also gar nicht geben — und es kam nie ein
  // einziger Bericht von dort an. Der Upload-Weg selbst war die ganze Zeit
  // plattformneutral (`sidecar-log.ts` kennt den Windows-Pfad ausdrücklich),
  // es fehlte allein der Schalter.
  const isDesktopApp = isElectron();

  // Für die Teile INNERHALB des Tabs, die es wirklich nur unter Linux gibt
  // (die Notbremse zurück auf den GSR-Sidecar).
  const isLinuxDesktop =
    isElectron() && typeof window !== 'undefined' && window.pulse?.os === 'linux';

  const tabs: {
    id: SettingsTab;
    label: string;
    icon: typeof MicIcon;
    desktopOnly?: true;
    browserOnly?: true;
    electronOnly?: true;
  }[] = [
    { id: 'profile', label: m.settings_dialog_tab_profile(), icon: UserIcon },
    { id: 'appearance', label: m.settings_dialog_tab_appearance(), icon: PaletteIcon },
    { id: 'audio-video', label: m.settings_dialog_tab_audio_video(), icon: MicIcon },
    { id: 'screen-share', label: m.settings_dialog_tab_screen_share(), icon: MonitorIcon, desktopOnly: true },
    { id: 'notifications', label: m.settings_dialog_tab_notifications(), icon: BellIcon },
    { id: 'sounds', label: m.settings_dialog_tab_sounds(), icon: Volume2Icon },
    { id: 'keyboard', label: m.settings_dialog_tab_keyboard(), icon: KeyboardIcon, desktopOnly: true },
    { id: 'privacy', label: m.settings_dialog_tab_privacy(), icon: LockIcon },
    { id: 'security', label: m.settings_dialog_tab_security(), icon: ShieldIcon },
    { id: 'self-host', label: m.settings_dialog_tab_self_host(), icon: ServerIcon },
    { id: 'apps', label: m.settings_dialog_tab_apps(), icon: DownloadIcon, browserOnly: true },
    { id: 'diagnostics', label: m.settings_dialog_tab_diagnostics(), icon: PlugZapIcon, electronOnly: true }
  ];

  let visibleTabs = $derived(
    tabs.filter(
      (t) =>
        (!t.desktopOnly || !viewport.isMobile) &&
        (!t.browserOnly || inBrowser) &&
        (!t.electronOnly || isDesktopApp)
    )
  );

  let activeLabel = $derived(visibleTabs.find((t) => t.id === activeTab)?.label ?? '');
</script>

<Dialog.Root bind:open>
  <!-- max-sm: Vollbild — liegt damit (anders als zentrierte Dialoge) unter der
       Status-Bar (Android Edge-to-Edge / iOS-PWA-Notch). pt-[var(--safe-top)]
       schiebt den Inhalt darunter raus, closeClass den absolut positionierten
       X-Button mit. -->
  <Dialog.Content
    class="flex w-full max-w-3xl gap-0 overflow-hidden p-0 sm:h-[min(44rem,85dvh)] sm:max-w-3xl max-sm:h-dvh max-sm:max-h-dvh max-sm:max-w-none max-sm:rounded-none max-sm:pt-[var(--safe-top)]"
    closeClass="max-sm:top-[calc(var(--safe-top)+1rem)]"
    data-testid="settings-dialog"
  >
    <!-- Zugänglicher Dialog-Titel — immer im DOM (auf Mobil wird die <nav> mit
         dem sichtbaren Titel ggf. ausgeblendet, daher hier separat als sr-only). -->
    <Dialog.Title class="sr-only">
      {mobileView === 'detail' && activeLabel ? m.settings_dialog_title_with_tab({ tab: activeLabel }) : m.settings_dialog_title()}
    </Dialog.Title>

    <!-- Nav-Liste: immer sichtbar auf sm+; auf mobile nur wenn mobileView=list -->
    <nav
      class="bg-bg-input flex shrink-0 flex-col gap-0.5 overflow-y-auto rounded-l-2xl p-3 max-sm:w-full max-sm:rounded-none sm:w-56
        {mobileView === 'detail' ? 'max-sm:hidden' : ''}"
    >
      <p class="text-text-muted px-2 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide">
        {m.settings_dialog_title()}
      </p>
      {#each visibleTabs as t (t.id)}
        <button
          type="button"
          onclick={() => selectTab(t.id)}
          class="flex items-center gap-2 rounded-xl px-2 py-3 text-left text-base transition-colors md:py-1.5 md:text-sm {activeTab ===
          t.id
            ? 'bg-bg-hover text-text-bright'
            : 'text-text-base hover:bg-bg-hover'}"
          data-testid="settings-tab-{t.id}"
        >
          <t.icon class="size-5 shrink-0 md:size-4" />
          {t.label}
        </button>
      {/each}
    </nav>

    <!-- Inhaltsbereich: auf sm+ inline; auf mobile nur wenn mobileView=detail -->
    <div
      class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden
        {mobileView === 'list' ? 'max-sm:hidden' : ''}"
    >
      <!-- Zurück-Button auf Mobile -->
      <div class="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4 sm:hidden">
        <Button
          variant="ghost"
          size="sm"
          onclick={() => (mobileView = 'list')}
          aria-label={m.settings_dialog_back()}
        >
          <ChevronLeftIcon class="text-text-muted size-5 md:size-4" />
          <span class="text-text-muted text-base md:text-sm">{m.settings_dialog_title()}</span>
        </Button>
        <span class="text-text-bright ml-1 text-sm font-semibold">{activeLabel}</span>
      </div>

      <div class="flex-1 overflow-y-auto pb-6 pl-6 pr-4 pt-14 max-sm:pt-6">
        {#if activeTab === 'profile'}
          <SettingsProfile />
        {:else if activeTab === 'appearance'}
          <SettingsAppearance />
        {:else if activeTab === 'audio-video'}
          <SettingsAudioVideo />
        {:else if activeTab === 'screen-share'}
          <SettingsScreenShare />
        {:else if activeTab === 'notifications'}
          <SettingsNotifications />
        {:else if activeTab === 'sounds'}
          <SettingsSounds />
        {:else if activeTab === 'keyboard'}
          <SettingsKeyboard />
        {:else if activeTab === 'privacy'}
          <SettingsPrivacy />
        {:else if activeTab === 'self-host'}
          <SettingsSelfHost />
        {:else if activeTab === 'apps'}
          <SettingsApps />
        {:else if activeTab === 'diagnostics'}
          <SettingsDiagnostics />
        {:else}
          <SettingsSecurity />
        {/if}
      </div>
    </div>
  </Dialog.Content>
</Dialog.Root>
