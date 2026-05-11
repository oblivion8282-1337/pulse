<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import SettingsAudioVideo from './settings/SettingsAudioVideo.svelte';
  import SettingsScreenShare from './settings/SettingsScreenShare.svelte';
  import MicIcon from '@lucide/svelte/icons/mic';
  import MonitorIcon from '@lucide/svelte/icons/monitor';

  type SettingsTab = 'audio-video' | 'screen-share';

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
    { id: 'audio-video', label: 'Sprache & Video', icon: MicIcon },
    { id: 'screen-share', label: 'Bildschirm teilen', icon: MonitorIcon }
  ];
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-w-3xl gap-0 p-0" data-testid="settings-dialog">
    <div class="flex max-h-[80vh] min-h-[28rem]">
      <nav class="bg-bg-sidebar flex w-48 shrink-0 flex-col gap-0.5 rounded-l-xl p-3">
        <Dialog.Title class="text-text-muted px-2 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide">
          Einstellungen
        </Dialog.Title>
        {#each tabs as t (t.id)}
          <button
            type="button"
            onclick={() => (activeTab = t.id)}
            class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors {activeTab ===
            t.id
              ? 'bg-white/10 text-text-bright'
              : 'text-text-base hover:bg-white/5'}"
            data-testid="settings-tab-{t.id}"
          >
            <t.icon class="size-4 shrink-0" />
            {t.label}
          </button>
        {/each}
      </nav>
      <div class="min-w-0 flex-1 overflow-y-auto p-6">
        {#if activeTab === 'audio-video'}
          <SettingsAudioVideo />
        {:else}
          <SettingsScreenShare />
        {/if}
      </div>
    </div>
  </Dialog.Content>
</Dialog.Root>
