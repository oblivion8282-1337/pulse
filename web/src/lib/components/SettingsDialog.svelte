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
  import { isCapacitorAndroid, isElectron } from '$lib/platform/runtime';
  import { darfStandplatzSein } from '$lib/remote/darfStandplatzSein';
  import { reiterSichtbar } from '$lib/devices/reiterSichtbar';
  import { geraeteAnmeldung } from '$lib/devices/anmeldung.svelte';
  import { deviceStore } from '$lib/devices/store.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button';
  import { getSettingsTabs, sichtbareReiter } from './settingsTabs';

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

  // browserOnly: in der Electron-App / im Android-Wrapper ausgeblendet —
  // dort ist die App schon installiert, Download-Links wären sinnlos.
  const inBrowser = !isElectron() && !isCapacitorAndroid();

  // electronOnly: jede Desktop-App, egal welche Plattform. Im Browser gibt es
  // keinen lokalen Sidecar und keine `sidecar.log`, dort gäbe es also nichts
  // einzustellen.
  //
  // **Hier stand bis 2026-08-06 `linuxOnly`**, aus der Zeit, als der Tab nur
  // den Rust-Linux-Sidecar umschaltete. Seit der Diagnose-Schalter im
  // „Experimental"-Tab sitzt,
  // war das ein stiller Ausschluss: Windows- und macOS-Nutzer sahen den Tab
  // nicht, konnten die Einwilligung also gar nicht geben — und es kam nie ein
  // einziger Bericht von dort an. Der Upload-Weg selbst war die ganze Zeit
  // plattformneutral (`sidecar-log.ts` kennt den Windows-Pfad ausdrücklich),
  // es fehlte allein der Schalter.
  const isDesktopApp = isElectron();

  // Zeigt dieser Client den Standplatz-Reiter? Drei Gründe, unabhängig
  // voneinander (`reiterSichtbar.ts`):
  //
  // * Dieser RECHNER kann selbst Standplatz sein (`darfStandplatzSein`) —
  //   dieselbe Bedingung wie bei der Anmeldung in `ws/handlers/ready.ts`.
  //   Reiter und Anmeldung liefen am 2026-08-18 schon einmal auseinander: der
  //   Reiter war unter Linux versteckt, die vorhandene Eintragung meldete
  //   sich trotzdem weiter an.
  // * Es liegt bereits eine Eintragung fuer diesen Server vor. Ohne diesen
  //   Fall waere der Reiter die Falle, die er am 2026-08-18 kurz war — die
  //   EINZIGE Stelle zum Entfernen einer Eintragung sitzt darin
  //   (`SettingsGeraeteEintragung`). Wer einen Rechner unter Windows
  //   eingetragen hat und ihn spaeter unter Linux startet, saehe sonst
  //   dauerhaft eine Geraetezeile in der Kanalliste und haette keinen Weg
  //   mehr, sie loszuwerden. Was man anlegen kann, muss man ueberall wieder
  //   abraeumen koennen.
  // * Dieser NUTZER besitzt Geraete auf diesem Server, unabhaengig davon, ob
  //   der Rechner, an dem er gerade sitzt, selbst Standplatz sein kann — der
  //   neue Fall seit 2026-08-20: auch unter Linux/macOS/Browser soll man die
  //   eigenen Geraete sehen und entfernen koennen.
  const zeigtStandplatzReiter = $derived(
    reiterSichtbar({
      kannStandplatzSein: darfStandplatzSein(),
      hatEintragung: !!geraeteAnmeldung.fuerServer(activeServer.serverId),
      besitztGeraete: deviceStore.eigene(currentServerUserId()).length > 0,
    }),
  );

  // Geräte für ALLE Communitys vorladen, sobald der Dialog öffnet — sonst
  // kennt `deviceStore.eigene()` oben nur die Community, deren Kanalliste
  // zuletzt offen war, und `zeigtStandplatzReiter` bliebe dauerhaft falsch,
  // wenn das eigene Gerät woanders steht oder der Dialog aus einer Ansicht
  // ohne aktive Community geöffnet wird (DM/Freunde, mobile Tabs). Der
  // einzige bisherige Nachlade-Pfad (`SettingsStandplatzGeraete`) lag HINTER
  // genau der Sichtbarkeitsentscheidung, die er beheben sollte — ein
  // Henne-Ei-Problem ohne Selbstheilung (Fix-Runde 1, 2026-08-20).
  //
  // `ensureLoaded` ist intern idempotent (bereits geladene Communitys werden
  // nicht neu geholt) — ein zweites Öffnen löst also keine neuen Anfragen
  // aus. Blockiert nicht: die Tabs richten sich reaktiv nach, sobald die
  // Daten da sind. `queueMicrotask` wie beim Vorbild in `app/+layout.svelte`,
  // wegen des Svelte-Effect-Depth-Guards.
  $effect(() => {
    if (!open) return;
    const guildIds = guilds.list.map((g) => g.id);
    queueMicrotask(() => {
      for (const id of guildIds) void deviceStore.ensureLoaded(id);
    });
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

  // Dieselbe Rechnung wie der Du-Bereich des Handys (`/app/me`) — ausgelagert
  // nach `settingsTabs.ts`, damit es nicht zwei davon gibt.
  let visibleTabs = $derived(
    sichtbareReiter(tabs, {
      istMobil: viewport.isMobile,
      imBrowser: inBrowser,
      istDesktopApp: isDesktopApp,
      zeigtStandplatz: zeigtStandplatzReiter
    })
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
