<!--
  SettingsDialogNav — die Tab-Leiste des Einstellungsdialogs.

  Aus `SettingsDialog.svelte` ausgelagert (Fix-Runde 1 zu Aufgabe 10, Grenze
  250 Zeilen). Reine Anzeige + Klick-Weiterleitung — welche Tabs überhaupt
  sichtbar sind, entscheidet weiter der Aufrufer (`visibleTabs`).
-->
<script lang="ts">
  import type { SettingsTab } from './SettingsDialog.svelte';
  import type { SettingsTabDef } from './settingsTabs';
  import { m } from '$lib/paraglide/messages.js';

  let {
    tabs,
    activeTab,
    mobileView,
    onSelect,
  }: {
    tabs: SettingsTabDef[];
    activeTab: SettingsTab;
    mobileView: 'list' | 'detail';
    onSelect: (id: SettingsTab) => void;
  } = $props();
</script>

<nav
  class="bg-bg-input flex shrink-0 flex-col gap-0.5 overflow-y-auto rounded-l-2xl p-3 max-sm:w-full max-sm:rounded-none sm:w-56
    {mobileView === 'detail' ? 'max-sm:hidden' : ''}"
>
  <p class="text-text-muted px-2 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide">
    {m.settings_dialog_title()}
  </p>
  {#each tabs as t (t.id)}
    <button
      type="button"
      onclick={() => onSelect(t.id)}
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
