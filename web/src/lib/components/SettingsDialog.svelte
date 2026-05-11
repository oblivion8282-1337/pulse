<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import SettingsAppearance from './settings/SettingsAppearance.svelte';
  import SettingsAudioVideo from './settings/SettingsAudioVideo.svelte';
  import SettingsScreenShare from './settings/SettingsScreenShare.svelte';
  import PaletteIcon from '@lucide/svelte/icons/palette';
  import MicIcon from '@lucide/svelte/icons/mic';
  import MonitorIcon from '@lucide/svelte/icons/monitor';

  type SettingsTab = 'appearance' | 'audio-video' | 'screen-share';

  let {
    open = $bindable(false),
    initialTab = 'audio-video'
  }: { open?: boolean; initialTab?: SettingsTab } = $props();

  let activeTab = $state<SettingsTab>('audio-video');

  // Jump to the requested tab whenever the dialog is (re)opened.
  $effect(() => {
    if (open) activeTab = initialTab;
  });

  const tabs: { id: SettingsTab; label: string; icon: typeof MicIcon }[] = [
    { id: 'appearance', label: 'Erscheinungsbild', icon: PaletteIcon },
    { id: 'audio-video', label: 'Sprache & Video', icon: MicIcon },
    { id: 'screen-share', label: 'Bildschirm teilen', icon: MonitorIcon }
  ];
</script>

<Dialog.Root bind:open>
  <Dialog.Content
    class="flex max-h-[85vh] min-h-[28rem] w-full max-w-3xl gap-0 overflow-hidden p-0 sm:max-w-3xl"
    data-testid="settings-dialog"
  >
    <nav class="bg-bg-input flex w-48 shrink-0 flex-col gap-0.5 overflow-y-auto rounded-l-2xl p-3">
      <Dialog.Title class="text-text-muted px-2 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide">
        Einstellungen
      </Dialog.Title>
      {#each tabs as t (t.id)}
        <button
          type="button"
          onclick={() => (activeTab = t.id)}
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
    <div class="min-h-0 min-w-0 flex-1 overflow-y-auto pb-6 pl-6 pr-4 pt-14">
      {#if activeTab === 'appearance'}
        <SettingsAppearance />
      {:else if activeTab === 'audio-video'}
        <SettingsAudioVideo />
      {:else}
        <SettingsScreenShare />
      {/if}
    </div>
  </Dialog.Content>
</Dialog.Root>
