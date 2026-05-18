<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import SettingsAppearance from './settings/SettingsAppearance.svelte';
  import SettingsAudioVideo from './settings/SettingsAudioVideo.svelte';
  import SettingsScreenShare from './settings/SettingsScreenShare.svelte';
  import SettingsNotifications from './settings/SettingsNotifications.svelte';
  import PaletteIcon from '@lucide/svelte/icons/palette';
  import MicIcon from '@lucide/svelte/icons/mic';
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import BellIcon from '@lucide/svelte/icons/bell';
  import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';

  type SettingsTab = 'appearance' | 'audio-video' | 'screen-share' | 'notifications';
  type MobileView = 'list' | 'detail';

  let {
    open = $bindable(false),
    initialTab = 'audio-video'
  }: { open?: boolean; initialTab?: SettingsTab } = $props();

  let activeTab = $state<SettingsTab>('audio-video');
  let mobileView = $state<MobileView>('list');

  // Jump to the requested tab whenever the dialog is (re)opened.
  $effect(() => {
    if (open) {
      activeTab = initialTab;
      mobileView = 'list';
    }
  });

  function selectTab(id: SettingsTab) {
    activeTab = id;
    mobileView = 'detail';
  }

  const tabs: { id: SettingsTab; label: string; icon: typeof MicIcon }[] = [
    { id: 'appearance', label: 'Erscheinungsbild', icon: PaletteIcon },
    { id: 'audio-video', label: 'Sprache & Video', icon: MicIcon },
    { id: 'screen-share', label: 'Bildschirm teilen', icon: MonitorIcon },
    { id: 'notifications', label: 'Benachrichtigungen', icon: BellIcon }
  ];

  let activeLabel = $derived(tabs.find((t) => t.id === activeTab)?.label ?? '');
</script>

<Dialog.Root bind:open>
  <Dialog.Content
    class="flex max-h-[85dvh] min-h-[28rem] w-full max-w-3xl gap-0 overflow-hidden p-0 sm:max-w-3xl max-sm:h-dvh max-sm:max-h-dvh max-sm:max-w-none max-sm:rounded-none"
    data-testid="settings-dialog"
  >
    <!-- Zugänglicher Dialog-Titel — immer im DOM (auf Mobil wird die <nav> mit
         dem sichtbaren Titel ggf. ausgeblendet, daher hier separat als sr-only). -->
    <Dialog.Title class="sr-only">
      Einstellungen{mobileView === 'detail' && activeLabel ? ` — ${activeLabel}` : ''}
    </Dialog.Title>

    <!-- Nav-Liste: immer sichtbar auf sm+; auf mobile nur wenn mobileView=list -->
    <nav
      class="bg-bg-input flex shrink-0 flex-col gap-0.5 overflow-y-auto rounded-l-2xl p-3 max-sm:w-full max-sm:rounded-none sm:w-48
        {mobileView === 'detail' ? 'max-sm:hidden' : ''}"
    >
      <p class="text-text-muted px-2 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide">
        Einstellungen
      </p>
      {#each tabs as t (t.id)}
        <button
          type="button"
          onclick={() => selectTab(t.id)}
          class="flex items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm transition-colors {activeTab ===
          t.id
            ? 'bg-bg-hover text-text-bright'
            : 'text-text-base hover:bg-bg-hover'}"
          data-testid="settings-tab-{t.id}"
        >
          <t.icon class="size-4 shrink-0" />
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
        <button
          type="button"
          onclick={() => (mobileView = 'list')}
          class="flex items-center gap-1 rounded-lg p-1 text-sm transition-colors hover:bg-bg-hover"
          aria-label="Zurück"
        >
          <ChevronLeftIcon class="text-text-muted size-4" />
          <span class="text-text-muted text-sm">Einstellungen</span>
        </button>
        <span class="text-text-bright ml-1 text-sm font-semibold">{activeLabel}</span>
      </div>

      <div class="flex-1 overflow-y-auto pb-6 pl-6 pr-4 pt-14 max-sm:pt-6">
        {#if activeTab === 'appearance'}
          <SettingsAppearance />
        {:else if activeTab === 'audio-video'}
          <SettingsAudioVideo />
        {:else if activeTab === 'screen-share'}
          <SettingsScreenShare />
        {:else}
          <SettingsNotifications />
        {/if}
      </div>
    </div>
  </Dialog.Content>
</Dialog.Root>
