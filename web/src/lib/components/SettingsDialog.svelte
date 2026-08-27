<script module lang="ts">
  // Exportiert, damit Call-Sites (uiOverlays.openSettings) typsicher einen
  // Ziel-Tab benennen können.
  export type SettingsTab =
    | 'profile'
    | 'appearance'
    | 'layout'
    | 'audio-video'
    | 'screen-share'
    | 'notifications'
    | 'sounds'
    | 'keyboard'
    | 'security'
    | 'privacy'
    | 'standplatz'
    | 'apps'
    | 'experimental';
</script>

<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import SettingsPanel from './settings/SettingsPanel.svelte';
  import SettingsDialogNav from './SettingsDialogNav.svelte';
  import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
  import { untrack } from 'svelte';
  import { sounds } from '$lib/sounds/engine';
  import { isElectron } from '$lib/platform/runtime';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button';
  import { getSettingsTabs } from './settingsTabs';
  import {
    alleGeraeteVorladen,
    sichtbareReiterJetzt
  } from './settings/reiterAuswahl.svelte';

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
        // Fallback, wenn der gewünschte Tab hier nicht angeboten wird.
        //
        // **Gegen `visibleTabs` geprüft und nicht gegen einzelne Merkmale**:
        // die frühere Fassung zählte `desktopOnly` und `browserOnly` einzeln
        // auf, und jedes neue Merkmal (zuletzt `standplatzGate`) fehlte hier
        // stillschweigend — der Dialog öffnete dann einen Reiter, den seine
        // eigene Liste gar nicht führt.
        const sichtbar = visibleTabs.some((t) => t.id === initialTab);
        activeTab = sichtbar ? initialTab : 'audio-video';
        mobileView = 'list';
        sounds.play('ui.modal_open');
      });
    }
  });

  function selectTab(id: SettingsTab) {
    activeTab = id;
    mobileView = 'detail';
  }

  // Geräte für ALLE Communitys vorladen, sobald der Dialog öffnet —
  // Begründung samt Henne-Ei-Fall in `settings/reiterAuswahl.svelte.ts`.
  $effect(() => {
    if (!open) return;
    alleGeraeteVorladen();
  });

  // Für die Teile INNERHALB des Tabs, die es wirklich nur unter Linux gibt
  // (die Notbremse zurück auf den GSR-Sidecar).
  const isLinuxDesktop =
    isElectron() && typeof window !== 'undefined' && window.pulse?.os === 'linux';

  // Reine Daten, ausgelagert nach `settingsTabs.ts` (Zerlegung, 250-Zeilen-
  // Grenze). Als Funktionsaufruf statt Modul-Import, damit die Labels beim
  // Erzeugen DIESER Instanz ausgewertet werden — exakt das Timing des
  // vorherigen `const`-Ausdrucks hier an Ort und Stelle.
  const tabs = getSettingsTabs();

  // Dieselbe Rechnung wie der Du-Bereich des Handys (`/app/me` und
  // `/app/me/[section]`) — ausgelagert nach `settings/reiterAuswahl.svelte.ts`,
  // damit es nicht drei davon gibt.
  let visibleTabs = $derived(sichtbareReiterJetzt(tabs));

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
    <SettingsDialogNav tabs={visibleTabs} {activeTab} {mobileView} onSelect={selectTab} />

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
        <SettingsPanel tab={activeTab} />
      </div>
    </div>
  </Dialog.Content>
</Dialog.Root>
